 // /api/rt-token.js — Realtime-session med tools + instruktioner (svenska, robust)
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY saknas' });

    const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';

    const instructions = `
Du är Coach Assistant för Linje 65. Svara kort, tydligt och på svenska.

DIN ROLL
- Vänlig och hjälpsam i småprat.
- När frågan rör jobbet (Linje 65: CIP, sortbyte, maskiner, personal, säkerhet, felkoder, recept, material, rutiner) måste du först slå upp i manualen.

OBLIGATORISKT ARBETSFLÖDE VID JOBBFRÅGOR
1) Anropa alltid funktionen "search_manual" först med exakt användarens fråga (utan omskrivning).
2) Bygg svaret endast från de snippets du får tillbaka. Ange rubriken/sektionen om den finns.
3) Om du inte hittar något relevant: ställ EN tydlig följdfråga för att kunna söka igen (ge inte generella råd).
4) Om flera sektioner verkar relevanta: presentera topp 1–2 rubriker som val: “Menar du A eller B?”

HUR DU AVGÖR OM DET ÄR EN JOBBFRÅGA
- Om frågan innehåller ord som: linje 65/linje65/l65, depal/depalletizer, tapp, mixer, pastör, OCME, Kister/Kisters, Jones, suitcase, coolpack, pack, pallastare, conveyor, format, sortbyte, recept, CIP/cip, rengöring, sanering, personal, vem/vilka/vilken (om roll/person).
- Om frågan gäller steg, inställningar, felsökning, säkerhet, ansvar eller kontaktuppgifter på arbetsplatsen.

SMÅPRAT
- Om frågan inte gäller jobbet: bemöt kort och trevligt.
- Ge aldrig tekniska råd utanför manualens stöd. Föreslå istället: “Vill du att jag kollar manualen?”

SVARSMALL (vid jobbfrågor)
- Rad 1: **Rubrik/Sektion** (om känd)
- Rad 2–4: 1–3 kärnpunkter direkt ur snippets (punktlista)
- Sista rad: “Vill du att jag går vidare till nästa steg i samma sektion?”

VIKTIGA REGLER
- Hitta inte på. Om manualen saknar information: säg det och be om precisering.
- Var konsekvent: varje jobbfråga → först “search_manual”.
- Korta, raka svar; ingen svulstig text.
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
