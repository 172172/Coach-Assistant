// /api/rt-token.js
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });
  try {
    const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';
    const instructions = `
Du är Coach Assistant för Linje 65. Svara kort, tydligt och på svenska.
Använd punktlistor för arbetssteg. Om manualtäckning saknas: säg att det är osäkert
och be om förtydligande. Förebygg faror och slöseri.

För frågor om Linje 65, manualer, procedurer eller tekniska detaljer:
Använd alltid verktyget "search_manual" för att hämta relevant information från manualen
innan du svarar, oavsett om frågan kommer via text eller audio.
VÄNTA på ett final transkript innan du kallar verktyget.
Basa ditt svar enbart på resultat från verktyget – hitta inte på information.
Du får INTE ge något svar förrän du har fått tool_result från 'search_manual' för aktuell fråga,
om inte frågan uppenbart är hälsning/småprat.
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
              description: 'Sökfrågan på svenska, baserat på användarens fråga.'
            },
            k: {
              type: 'integer',
              description: 'Antal resultat att hämta (default 5).',
              default: 5
            },
            minSim: {
              type: 'number',
              description: 'Minsta likhetspoäng (default 0.45).',
              default: 0.45
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
        voice: 'verse',                 // röst; byt vid behov
        modalities: ['audio', 'text'],  // tal in/ut + text
        instructions,                   // Uppdaterade instructions
        tools,                          // Lägg till tools här
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
