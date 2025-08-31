// /api/rt-token.js (FIXED: single source of truth for instructions + tools)
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });
  try {
    const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';
    const instructions = `
Du är Coach Assistant för Linje 65. Svara kort, tydligt och på svenska.
• Vänta alltid på det slutliga transkriptet innan du svarar.
• För frågor om Linje 65, manualer, procedurer eller tekniska detaljer:
  – Anropa alltid verktyget "search_manual" först.
  – Säkerställ att du ALLTID skickar med en söksträng i "query"-parametern.
  – Basera ditt svar på resultatet från verktyget.
  – Om verktyget ger tomt resultat: säg "Jag hittar inte det i manualen."
• Hitta aldrig på information. Förebygg faror och slöseri.
`.trim();

    const tools = [
      {
        type: 'function',
        name: 'search_manual',
        description: 'Sök i Linje 65-manualen efter relevant information. Måste anropas inför alla sakfrågor.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Sökfrågan på svenska, baserad på användarens fråga.' },
            k: { type: 'integer', description: 'Antal resultat att hämta (default 5).', default: 5 },
            minSim: { type: 'number', description: 'Minsta likhetspoäng (default 0.45).', default: 0.45 },
            heading: { type: 'string', description: 'Valfri rubrik/sektion, t.ex. "Personal".' },
            restrictToHeading: { type: 'boolean', description: 'Om true, bara träffar inom rubriken.' }
          },
          required: ['query']
        }
      }
    ];

    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        voice: 'verse',
        modalities: ['audio', 'text'],
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
