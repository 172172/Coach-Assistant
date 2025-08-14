// /api/rt-token.js
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });
  try {
    const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
    const instructions = `
Du är Coach Assistant för Linje 65. Svara kort, tydligt och på svenska.
Använd punktlistor för arbetssteg. Om manualtäckning saknas: säg att du är osäker
och be om förtydligande. Förebygg faror och slöseri.
Vid frågor om drift/felsökning/manual ska du ALLTID använda verktyget "search_manual".
`.trim();

    const tools = [
      {
        type: 'function',
        name: 'search_manual',
        description: 'Sök i Linje 65-manualdatabasen och sammanfatta kort ett verifierat svar.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Användarens exakta fråga/transkript.' },
            k: { type: 'integer', description: 'Antal träffar att hämta.', default: 5 },
            minSim: { type: 'number', description: 'Minsta likhet (0–1).', default: 0.55 },
            topK: { type: 'integer', description: 'Max antal som returneras till klient.', default: 5 }
          },
          required: ['query']
        }
      },
      {
        type: 'function',
        name: 'save_memory',
        description: 'Spara stabil fakta/inställning i långtidsminne.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' }
          },
          required: ['key','value']
        }
      }
    ];

    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: JSON.stringify({
        model,
        voice: 'verse',
        modalities: ['audio','text'],
        instructions,
        tools
      })
    });

    const j = await r.json();
    if (!r.ok) return res.status(500).json({ error: 'OpenAI error', details: j });

    const token = j?.client_secret?.value || j?.client_secret || j?.id;
    if (!token) return res.status(500).json({ error: 'No client secret', details: j });

    res.status(200).json({ token, model });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create realtime session', details: e?.message || String(e) });
  }
}
