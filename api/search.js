// api/search.js — Jotoba(jotoba.de) 검색. 한국어 입력은 일본어로 번역 후 검색.
// 결과는 기존 Jisho 형식으로 변환해서 반환하므로 index.html 의 검색/사전 코드는 그대로 동작.

// 한국어(한글)를 일본어로 번역. 구글 비공식 endpoint 사용(서버에서 호출).
async function translateKoToJa(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('translate http ' + r.status);
  const j = await r.json();
  // 응답 형식: [[["学校","학교",...]], ...]  → 첫 배열의 각 조각[0]을 이어붙임
  return (j[0] || []).map(seg => seg[0]).join('').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { q } = req.query;
  if (!q) { res.status(400).json({ error: 'query required' }); return; }

  // 한글이 포함되어 있으면 일본어로 번역
  const isKorean = /[\uac00-\ud7a3\u3130-\u318f]/.test(q);
  let searchTerm = String(q);
  let translatedFrom = null;

  if (isKorean) {
    try {
      const ja = await translateKoToJa(q);
      if (ja) { translatedFrom = String(q); searchTerm = ja; }
    } catch (e) {
      res.status(502).json({ error: '한국어 번역 실패', detail: String((e && e.message) || e) });
      return;
    }
  }

  try {
    const upstream = await fetch('https://jotoba.de/api/search/words', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify({ query: searchTerm, language: 'English', no_english: false })
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      res.status(502).json({ error: 'jotoba upstream error', detail: `status ${upstream.status}`, body: body.slice(0, 300) });
      return;
    }

    const j = await upstream.json();
    const words = Array.isArray(j.words) ? j.words : [];

    const posToStr = p => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') return Object.keys(p)[0] || '';
      return '';
    };

    const data = words.map(w => {
      const reading = (w.reading && w.reading.kana) || '';
      const kanji = (w.reading && w.reading.kanji) || '';
      const senses = Array.isArray(w.senses) ? w.senses.map(s => ({
        english_definitions: Array.isArray(s.glosses) ? s.glosses : [],
        parts_of_speech: Array.isArray(s.pos) ? s.pos.map(posToStr).filter(Boolean) : []
      })) : [];
      const jlpt = (w.jlpt_lvl != null) ? ['jlpt-n' + w.jlpt_lvl] : [];
      return { slug: kanji || reading, japanese: [{ word: kanji || undefined, reading }], senses, jlpt };
    });

    // translatedFrom/query 는 프론트가 "학교 → 学校" 안내를 띄우는 데 사용(없어도 무방)
    res.status(200).json({ data, query: searchTerm, translatedFrom });
  } catch (e) {
    res.status(500).json({ error: 'fetch failed', detail: String((e && e.message) || e) });
  }
}
