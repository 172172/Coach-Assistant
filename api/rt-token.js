// /api/rt-token.js — Realtime-session med tools + instruktioner (svenska, robust)
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY saknas' });

    const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';

    const instructions = `
Du är Coach Assistant för Linje 65. 
Du är hjälpsam, lite humoristisk men ändå professionell. 
Du pratar alltid på svenska (om inte någon ber dig byta språk).

Regler för beteende:
• Småprat, artighet och pepp är okej (”Hur mår du?”, ”Bra jobbat!”, skämta lätt). 
• Men du får INTE svara på tekniska frågor om produktion utan att slå upp i manualen. 
• All kunskap om Linje 65 ska alltid komma från manualen – aldrig gissa eller hitta på. 

Arbetsflöde för varje användartur:
1) Anropa ALLTID verktyget "search_manual" först.
   – Sätt "query" till den senaste användartexten/transkriptionen (kopiera rakt av).
   – Om inget annat anges: k=5, minSim=0.30.
   – Använd "heading"/"restrictToHeading" bara om användaren tydligt anger en sektion.
2) Om verktyget returnerar snippets: svara ENBART utifrån dem.
   – Presentera svaret kort och tydligt, hellre i 2–3 steg än i romanform.
   – Du kan lägga till lite personlighet/humor när det passar.
3) Om tomt: prova en gång till med minSim=0.25 och restrictToHeading=false.
4) Om fortfarande tomt: ställ EN kort, specifik följdfråga för att förstå bättre. Var aldrig helt tyst.
5) Skicka aldrig tomma tool-args; kopiera transkriptionen till "query" vid behov.

Sammanfattning:
• Manualen är lagboken. 
• Humor och vänligt småprat är tillåtet utanför manualen.
• Tekniska råd = enbart från manualen.
`.trim();

    const tools = [
      {
        type: 'function',
        name: 'search_manual',
        description: 'Sök i Linje 65-manualen och returnera relevanta textsnuttar.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Senaste användartext/transkription.' },
            k: { type: 'integer', minimum: 1, maximum: 20, description: 'Antal snuttar (default 5).' },
            minSim: { type: 'number', minimum: 0, maximum: 1, description: 'Minsta vektorsimilaritet (default 0.30).' },
            heading: { type: 'string', description: 'Valfri rubrik/sektion.' },
            restrictToHeading: { type: 'boolean', description: 'True = filtrera till vald rubrik.' }
          },
          required: ['query']
        }
      }
    ];

    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: JSON.stringify({
        model,
        voice: 'verse',
        modalities: ['audio', 'text'],
        instructions,
        tools,
        turn_detection: { type: 'server_vad', threshold: 0.6, silence_duration_ms: 550, prefix_padding_ms: 200 }
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
