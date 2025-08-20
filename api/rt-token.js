export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });
  try {
    const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';
    const instructions = `
Du är Coach Assistant för Linje 65. Svara kort, tydligt och på svenska.
Använd punktlistor för arbetssteg. Om manualtäckning saknas: säg att det är osäkert
och be om förtydligande. Förebygg faror och slöseri.

För ALLA frågor (inklusive voice/audio-inputs) om Linje 65, manualer, procedurer eller tekniska detaljer:
- VÄNTA ALLTID på final transkript (efter input_audio_buffer.commit).
- Kallar OMEDELBART verktyget "search_manual" med query baserat på final transkript.
- Basa ditt svar ENDAST på resultat från verktyget – svara INTE utan tool_result.
- Om frågan är småprat/hälsning, svara direkt utan tool.
- För voice: Ignorera partial transkripts; använd bara final för tool-call.
`.trim();

    const tools = [
      {
        type: 'function',
        name: 'search_manual',
        description: 'Sök i Linje 65-manualen efter relevant information. Använd detta för alla frågor som rör manualer, procedurer eller tekniska detaljer.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Sökfrågan på svenska, baserat på final transkript.'
            },
            k: {
              type: 'integer',
              description: 'Antal resultat att hämta (default 8).',
              default: 8
            },
            minSim: {
              type: 'number',
              description: 'Minsta likhetspoäng (default 0.35 för voice).',
              default: 0.35
            },
            isVoice: {
              type: 'boolean',
              description: 'Indikerar om frågan kommer från voice-input (default false).',
              default: false
            }
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
        tools,
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
