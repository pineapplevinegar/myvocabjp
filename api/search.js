// api/search.js — Jotoba 검색 + 한국어 입력 번역 + 영어뜻→한국어 번역 + JLPT 보조조회.
// 결과는 기존 Jisho 형식으로 변환. meaning_ko / korean_definitions / jlpt 를 추가로 채움.

// === 번역 ===
// Google Translate 비공식 endpoint (1차)
async function googleTranslate(text, sl, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('google http ' + r.status);
  const j = await r.json();
  const result = (j[0] || []).map(s => s[0]).join('').trim();
  if (!result) throw new Error('google empty');
  return result;
}

// MyMemory API (2차 fallback, 서버사이드에서 안정적)
async function mymemoryTranslate(text, sl, tl) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sl}|${tl}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('mymemory http ' + r.status);
  const j = await r.json();
  const result = (j && j.responseData && j.responseData.translatedText || '').trim();
  if (!result) throw new Error('mymemory empty');
  // 무료 티어 경고 메시지 필터링 (예: "PLEASE SELECT...", "MYMEMORY WARNING...")
  if (/^(PLEASE|MYMEMORY WARNING|INVALID|NO QUERY)/i.test(result)) {
    throw new Error('mymemory warning: ' + result.slice(0, 60));
  }
  return result;
}

// 멀티 소스 번역 — Google 실패 시 MyMemory로 폴백
async function translate(text, sl, tl) {
  if (!text) return '';
  try {
    return await googleTranslate(text, sl, tl);
  } catch (e) {
    console.warn('[translate] google failed:', String(e.message || e));
  }
  try {
    return await mymemoryTranslate(text, sl, tl);
  } catch (e) {
    console.warn('[translate] mymemory failed:', String(e.message || e));
  }
  return '';
}
const enToKo = t => translate(t, 'en', 'ko');
const koToJa = t => translate(t, 'ko', 'ja');

// JLPT 레벨 보조 조회 (wkei/jlpt-vocab-api). 실패하면 null.
async function jlptLevel(word, reading) {
  try {
    const key = word || reading;
    if (!key) return null;
    const r = await fetch(`https://jlpt-vocab-api.vercel.app/api/words?word=${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const j = await r.json();
    const arr = Array.isArray(j.words) ? j.words : [];
    if (!arr.length) return null;
    const m = arr.find(x => x.word === word) || arr.find(x => x.furigana === reading) || arr[0];
    return (m && m.level != null) ? m.level : null; // level: 5=N5 ... 1=N1
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { q } = req.query;
  if (!q) { res.status(400).json({ error: 'query required' }); return; }
  const full = req.query.full === '1'; // 사전 패널(단일 단어 상세)용

  // 한글이면 일본어로 번역해서 검색
  const isKorean = /[\uac00-\ud7a3\u3130-\u318f]/.test(q);
  let searchTerm = String(q);
  let translatedFrom = null;
  if (isKorean) {
    try {
      const ja = await koToJa(q);
      if (ja) { translatedFrom = String(q); searchTerm = ja; }
    } catch (e) {
      res.status(502).json({ error: '한국어 번역 실패', detail: String((e && e.message) || e) });
      return;
    }
  }

  try {
    const upstream = await fetch('https://jotoba.de/api/search/words', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ query: searchTerm, language: 'English', no_english: false })
    });
    if (!upstream.ok) {
      const body = await upstream.text();
      res.status(502).json({ error: 'jotoba upstream error', detail: `status ${upstream.status}`, body: body.slice(0, 300) });
      return;
    }

    const j = await upstream.json();
    const words = Array.isArray(j.words) ? j.words : [];
    const posToStr = p => (typeof p === 'string') ? p : (p && typeof p === 'object') ? (Object.keys(p)[0] || '') : '';

    let data = words.map(w => {
      const reading = (w.reading && w.reading.kana) || '';
      const kanji = (w.reading && w.reading.kanji) || '';
      const senses = Array.isArray(w.senses) ? w.senses.map(s => ({
        english_definitions: Array.isArray(s.glosses) ? s.glosses : [],
        parts_of_speech: Array.isArray(s.pos) ? s.pos.map(posToStr).filter(Boolean) : []
      })) : [];
      const jlpt = (w.jlpt_lvl != null) ? ['jlpt-n' + w.jlpt_lvl] : [];
      return { slug: kanji || reading, japanese: [{ word: kanji || undefined, reading }], senses, jlpt };
    });

    // 보여줄 만큼만 가공 (목록은 4개, 상세는 1개)
    data = data.slice(0, full ? 1 : 4);

    await Promise.all(data.map(async d => {
      const word = d.japanese[0].word || '';
      const reading = d.japanese[0].reading || '';

      // 대표 뜻을 한국어로 번역
      const eng0 = (d.senses[0]?.english_definitions || []).slice(0, 3).join(', ');
      try { d.meaning_ko = eng0 ? await enToKo(eng0) : ''; } catch (e) { d.meaning_ko = ''; }

      // JLPT 가 비어 있으면 보조 조회
      if (!d.jlpt.length) {
        const lvl = await jlptLevel(word, reading);
        if (lvl != null) d.jlpt = ['jlpt-n' + lvl];
      }

      // 상세 패널이면 각 뜻을 한국어로 번역
      if (full) {
        await Promise.all((d.senses || []).slice(0, 5).map(async s => {
          const e = (s.english_definitions || []).join(', ');
          try { s.korean_definitions = e ? await enToKo(e) : ''; } catch (_) { s.korean_definitions = ''; }
        }));
      }
    }));

    res.status(200).json({ data, query: searchTerm, translatedFrom });
  } catch (e) {
    res.status(500).json({ error: 'fetch failed', detail: String((e && e.message) || e) });
  }
}
