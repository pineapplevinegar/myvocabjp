export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { q } = req.query;
  if (!q) { res.status(400).json({ error: 'query required' }); return; }

  try {
    const response = await fetch(
      `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'fetch failed' });
  }
}
