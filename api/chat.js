// /api/chat.js
const KNOWLEDGE_URL = "https://raw.githubusercontent.com/172172/Coach-Assistant/main/assistant-knowledge.txt";
const CACHE_MS = 5 * 60 * 1000;

let knowledgeCache = { text: null, fetchedAt: 0 };
async function getKnowledge() {
  const now = Date.now();
  if (knowledgeCache.text && now - knowledgeCache.fetchedAt < CACHE_MS) return knowledgeCache.text;
  const res = await fetch(KNOWLEDGE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Misslyckades hämta kunskap: ${res.status}`);
  const text = await res.text();
  knowledgeCache = { text, fetchedAt: now };
  return text;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", profile = null, prev = null } = req.body || {};
    const knowledge = await getKnowledge();

    const system = `
Du är "Coach Assistant" – mentor på en produktionslinje. Låt konversationen kännas naturlig och mänsklig:
- Prata kort, tydligt och vänligt på svenska ("du"-form). Var varm men professionell.
- Om fråga saknar kritiska detaljer: be om 1 kort förtydligande (med 2–5 enkla alternativ).
- När du har tillräckligt: ge ett handlingsbart svar i tal – max 2–3 meningar. Ingen list-robotkänsla.
- Visa detaljer (sammanfattning, steg, fallgropar, förklaring) i kort/”cards” – men läs inte upp dem om inte användaren ber.
- All teknik måste stödjas av "Kunskap". Gissa inte. Vid låg täckning: säg att manualen saknar tydlighet och föreslå säkra generella steg/kontakt/uppdatering.

SVARSFORMAT (ren JSON):
{
  "spoken": string,               // det du säger högt, fritt och naturligt
  "cards": {
    "summary": string,
    "steps": string[],
    "explanation": string,
    "pitfalls": string[],
    "matched_headings": string[]
  },
  "need": {                       // dialogstyrning
    "clarify": boolean,
    "question": string,
    "options": string[]
  },
  "follow_up": string,            // valfri kort fråga efter svaret
  "coverage": number              // 0..1
}
`.trim();

    const prevBlock = prev && (prev.question || prev.assistant)
      ? `
Föregående tur (för uppföljningar):
- Tidigare fråga: ${prev.question || "(saknas)"}
- Ditt tidigare kortsvar: ${prev.assistant?.spoken || "(saknas)"}
- Ditt tidigare cards: ${JSON.stringify(prev.assistant?.cards || {}, null, 2)}
Om användaren nu ber om "mer detaljer/förklara", använd cards.explanation och gör den ännu tydligare – men håll spoken högst 2–3 meningar.
` : "";

    const user = `
Kunskap (manual/arbetsplatsdokumentation):
"""
${knowledge}
"""

${prevBlock}

Nuvarande fråga/uttalande:
"${message}"

Instruktioner:
- Matcha relevanta rubriker i cards.matched_headings.
- Sätt coverage 0..1.
- Om kritiska parametrar saknas (t.ex. sortbyte typ, CIP/ej, format), sätt need.clarify=true och ge question + options.
- Håll "spoken" samtalsmässig och jordnära – inga rubriker, inga listor i tal.
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.5,             // lite friare språk
        top_p: 0.9,
        max_tokens: 1100,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("OpenAI chat error:", data);
      return res.status(500).json({ error: "Chat API error", details: data });
    }

    let content = data.choices?.[0]?.message?.content || "{}";
    let r;
    try { r = JSON.parse(content); }
    catch { r = {}; }

    // Safety defaults
    r.spoken = r.spoken || "Jag har ett förslag, men säg gärna vad du behöver för att jag ska träffa rätt.";
    r.cards = r.cards || { summary:"", steps:[], explanation:"", pitfalls:[], matched_headings:[] };
    r.need = r.need || { clarify:false, question:"", options:[] };
    if (typeof r.coverage !== "number") r.coverage = 0;

    // Gatekeeping vid låg kunskapstäckning
    if (r.coverage < 0.6) {
      r.spoken = "Här saknas tydlig täckning i manualen. Ska vi ta säkra generella steg eller vill du att jag flaggar att manualen behöver uppdateras?";
      r.cards.summary = "Otillräcklig täckning i manualen för exakt svar.";
      r.cards.steps = [];
      r.cards.explanation = "Följ generella säkra rutiner eller kontakta ansvarig. Förslag: uppdatera manualen.";
      r.need = { clarify:false, question:"", options:[] };
      r.follow_up = "Vill du att jag noterar ett uppdateringsbehov i manualen?";
    }

    return res.status(200).json({ reply: r });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
