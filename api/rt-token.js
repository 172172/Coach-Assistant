// /api/rt-token.js
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });
  try {
    const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';
    const instructions = `
Du är Coach Assistant för Linje 65. Svara kort, tydligt och på svenska.
Använd punktlistor för arbetssteg. Om manualtäckning saknas: säg det är osäkert
och be om förtydligande. Förebygg faror och slöseri.
`;

    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        voice: 'verse',                 // röst; byt vid behov
        modalities: ['audio', 'text'],  // tal in/ut + text
        instructions,                   // Linje 65-kontekst
        // turn_detection kan även styras efter anslutning via session.update (klienten)
      })
    });

    const j = await r.json();
    if (!r.ok) return res.status(500).json({ error: 'OpenAI error', details: j });

    // Kortlivat token som webbläsaren får använda för WebRTC
    const token = j?.client_secret?.value || j?.client_secret || j?.id;
    if (!token) return res.status(500).json({ error: 'No client secret', details: j });

    res.status(200).json({ token, model });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create realtime session', details: e?.message || String(e) });
  }
}
