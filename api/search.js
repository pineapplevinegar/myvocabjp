// api/search.js — Jotoba(jotoba.de)를 호출하고, 결과를 기존 Jisho 형식으로 변환해서 반환.
// 이렇게 하면 index.html 의 검색/사전 패널 코드를 그대로 둬도 동작함.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { q } = req.query;
  if (!q) { res.status(400).json({ error: 'query required' }); return; }

  try {
    const upstream = await fetch('https://jotoba.de/api/search/words', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify({ query: String(q), language: 'English', no_english: false })
    });

    // 200이 아니면 실제 상태/본문을 그대로 넘겨 원인 파악 가능하게
    if (!upstream.ok) {
      const body = await upstream.text();
      res.status(502).json({
        error: 'jotoba upstream error',
        detail: `status ${upstream.status}`,
        body: body.slice(0, 300)
      });
      return;
    }

    const j = await upstream.json();
    const words = Array.isArray(j.words) ? j.words : [];

    // Jotoba의 pos는 문자열이거나 {"Verb": ...} 형태의 객체일 수 있어 방어적으로 처리
    const posToStr = p => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') return Object.keys(p)[0] || '';
      return '';
    };

    // Jotoba → Jisho 형식 변환
    const data = words.map(w => {
      const reading = (w.reading && w.reading.kana) || '';
      const kanji = (w.reading && w.reading.kanji) || '';
      const senses = Array.isArray(w.senses) ? w.senses.map(s => ({
        english_definitions: Array.isArray(s.glosses) ? s.glosses : [],
        parts_of_speech: Array.isArray(s.pos) ? s.pos.map(posToStr).filter(Boolean) : []
      })) : [];
      // jlpt_lvl 가 있으면 "jlpt-n5" 처럼 변환 (없으면 빈 배열 → 프론트에서 배지 생략)
      const jlpt = (w.jlpt_lvl != null) ? ['jlpt-n' + w.jlpt_lvl] : [];
      return {
        slug: kanji || reading,
        japanese: [{ word: kanji || undefined, reading }],
        senses,
        jlpt
      };
    });

    res.status(200).json({ data });
  } catch (e) {
    // 예: 'fetch is not defined'(Node 18 미만) → API가 아니라 실행환경 문제라는 뜻
    res.status(500).json({ error: 'fetch failed', detail: String((e && e.message) || e) });
  }
}
