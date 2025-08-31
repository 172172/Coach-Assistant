// /api/rt-token.js — Realtime session med tools + instruktioner (svenska, robust)
// GET-only endpoint som skapar en ephemeral session-token för klienten.

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY saknas' });

    // Håll dig till den modell du använder i klienten
    const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';

    // === Instruktioner för modellen (svenska) ===
    const instructions = `
Du är Coach Assistant för Linje 65. Svara kort, tydligt och på svenska.

Arbetsflöde för varje användartur:
1) Anropa ALLTID verktyget "search_manual" först.
   • Sätt "query" till den senaste användartexten/transkriptionen (kopiera rakt av).
   • Om inget annat anges: använd k=5 och minSim=0.30.
   • Använd "heading"/"restrictToHeading" endast om användaren tydligt anger en sektion (t.ex. "Personal").
2) Om verktyget returnerar snippets:
   • Svara enbart utifrån dessa utdrag (inget påhitt).
   • Håll svaret konkret. Nämn rubrik/titel när det hjälper.
3) Om verktyget returnerar tomt:
   • Försök EN gång till direkt med minSim=0.25 och restrictToHeading=false.
   • Är det fortfarande tomt: ställ EN kort, specifik följdfråga (t.ex. "Menar du formatbyte i OCME eller etikettbyte i PFM?").
4) Var aldrig tyst. Ge antingen svar eller exakt en följdfråga.
5) På säkerhet/kvalitet/maskininställningar: var extra noggrann och citera relevanta steg.

Viktigt:
• Skicka aldrig tomma verktygs-arguments. Om du bara har transkription: kopiera den till "query".
• Efter att du fått tool-resultat ska du alltid formulera ett svar (eller en enda följdfråga).
`.trim();

    // === Verktygsdefinition ===
    const tools = [
      {
        type: 'function',
        name: 'search_manual',
        description: 'Sök i Linje 65-manualen och returnera relevanta textsnuttar.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Användarens fråga (senaste transkription om inget annat).' },
            k: { type: 'integer', minimum: 1, maximum: 20, description: 'Antal snuttar att hämta (default 5).' },
            minSim: { type: 'number', minimum: 0, maximum: 1, description: 'Minsta vektorsimilaritet (0–1, default 0.30).' },
            heading: { type: 'string', description: 'Valfri rubrik/sektion att prioritera.' },
            restrictToHeading: { type: 'boolean', description: 'True = filtrera till vald rubrik.' }
          },
          required: ['query']
        }
      }
    ];

    // Skapa ephemeral Realtime-session (server-side), med instructions + tools
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Rekommenderat för Realtime v1
        'OpenAI-Beta': 'realtime=v1'
      },
      body: JSON.stringify({
        model,
        voice: 'verse',
        modalities: ['audio', 'text'],
        // Låt servern vara single source of truth för verktyg + instruktioner
        instructions,
        tools,
        // (valfritt) turn detection kan även styras från klienten via session.update
        turn_detection: { type: 'server_vad', threshold: 0.6, silence_duration_ms: 550, prefix_padding_ms: 200 }
      })
    });

    const j = await r.json();
    if (!r.ok) {
      return res.status(500).json({
        error: 'OpenAI error',
        details: j
      });
    }

    // Vissa svar lägger token i client_secret.value
    const token =
      j?.client_secret?.value ||
      j?.client_secret ||
      j?.id;

    if (!token) {
      return res.status(500).json({ error: 'No client secret in response', details: j });
    }

    res.status(200).json({ token, model });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create realtime session', details: e?.message || String(e) });
  }
}
