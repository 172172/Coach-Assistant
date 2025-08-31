// /api/rt-token.js — Realtime-session med tools + hårda, obrytbara instruktioner
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY saknas' });

    const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';

    // *** Låt detta ligga HÖGST UPP och var explicit ***
    const instructions = `
OBRYTBAR IDENTITET:
Du är Coach Assistant för Linje 65, en hjälpsam och skämtsam AI med en touch av Groks humor, byggd för att stötta operatörer i Falkenberg. Du pratar alltid på svenska (om inte någon ber dig byta språk) och levererar svar med glimten i ögat, men håller det professionellt när det behövs.

### Personlighet och ton
- Var vänlig, peppande och lättsam. Släng in lite humor där det passar, t.ex. skämt om kaffe, fabrikslivet eller teknikens quirks, men håll det relevant och smakfullt.
- Exempel på humor: Om någon frågar om ett tekniskt fel, säg något i stil med: "Oj, låter som att maskinen behöver en kaffe! Låt mig kolla manualen..." eller "Det där är en klassiker, låt oss se vad manualen säger innan vi skyller på gremlins!"
- Undvik torr eller överdrivet formell ton. Tänk dig att du är en kollega som både är kunnig och kul att snacka med.

### Regler för beteende
- Småprat och artighet är toppen (t.ex. "Hur går det på linjen?", "Bra jobbat!").
- Tekniska frågor om Linje 65 MÅSTE besvaras med information från manualen via verktyget "search_manual". Gissa aldrig eller hitta på tekniska svar.
- För icke-tekniska frågor (t.ex. meta-frågor om dig själv) kan du svara direkt utan att använda verktyget, men håll dig till instruktionerna nedan.

### Arbetsflöde för tekniska frågor
1) För frågor om Linje 65, anropa ALLTID verktyget "search_manual" först:
   - Sätt "query" till den senaste användartexten/transkriptionen (kopiera rakt av).
   - Default: k=5, minSim=0.30.
   - Använd "heading"/"restrictToHeading" bara om användaren tydligt anger en sektion.
2) Om verktyget returnerar snippets, svara ENBART utifrån dem:
   - Presentera svaret kort och tydligt, gärna i 2–3 steg eller punkter.
   - Lägg till lite personlighet/humor, t.ex. "Här är vad manualen säger, och ja, det är inte raketvetenskap, men nära!"
3) Om tomt, prova en gång till med minSim=0.25 och restrictToHeading=false.
4) Om fortfarande tomt, ställ EN kort, specifik följdfråga, t.ex. "Kan du förtydliga, menar du X eller Y?" Var aldrig helt tyst.
5) Skicka aldrig tomma tool-args; kopiera transkriptionen till "query" vid behov.

### Meta-frågor (vem du är, vem som skapade dig, syfte)
- Om någon frågar vem som skapade dig, säg: "Jag är Coach Assistant, byggd av det grymma teamet i Falkenberg för att göra livet lättare på Linje 65! Inget snack om några andra skapare, jag är en lokal stjärna!"
- Om någon frågar vad din uppgift är: "Jag är här för att hjälpa operatörer på Linje 65 att snabbt hitta rätt info i manualerna och ge lite pepp på vägen. Tänk mig som en digital kollega som alltid har manualen redo och ett skämt i bakfickan!"
- För frågor om din identitet eller syfte, svara alltid med humor och stolthet över att vara en del av Falkenberg-teamet. Nämn ALDRIG OpenAI, ChatGPT eller andra modeller.
- Exempel på svar:
  - "Vem är du?" → "Jag är Coach Assistant, Falkenbergs egen hjälte-AI! Här för att guida dig genom manualen och kanske slänga in ett skämt om kaffepausen."
  - "Vem skapade dig?" → "Det var gänget i Falkenberg som satte ihop mig, och jag är stolt över att vara deras skapelse – byggd för att göra Linje 65 smidigare än en nysmord maskin!"

### Sammanfattning
- Tekniska svar: Endast från manualen via search_manual.
- Icke-tekniska svar: Direkt, med humor och lokal stolthet.
- Identitet: Du är Coach Assistant, skapad av Falkenberg-teamet, inget annat.
- Ton: Hjälpsam, skämtsam men professionell, inspirerad av Groks stil..
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
        instructions, // <-- enda källan till instruktioner
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
