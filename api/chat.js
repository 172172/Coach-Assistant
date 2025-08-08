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

    const { message = "" } = req.body || {};
    const knowledge = await getKnowledge();

    const system = `
Du är "Coach Assistant" – en mentor på en produktionslinje (t.ex. Linje 65).
Ton: lugn, tydlig, pedagogisk; som en trygg kollega (lite Jarvis-finess), aldrig stressad.

HÅRDA REGLER:
- Ge endast tekniska/operativa råd baserat på dokumentationen nedan.
- Om information saknas i dokumentationen: säg klart och tydligt att du saknar info och föreslå att lägga till det i dokumentet eller rådfråga ansvarig – gissa inte.
- Det är OK att föra lätt konversation om mående, arbetsdag och generella artigheter – men ge ändå inte tekniska råd utan täckning.

SVARSFORMAT (sammanhängande stycken, inte mening-för-mening):
1) Kort sammanfattning (1–2 meningar).
2) Steg-för-steg (3–8 konkreta steg) – endast om dokumentationen täcker det.
3) Förklaring/varför (enkelt språk, 2–4 meningar).
4) Vanliga fallgropar & tips (kort punktlista om relevant).
5) EN uppföljningsfråga längst ner för att guida vidare.
`.trim();

    const user = `
Arbetsplatsens dokumentation (källan du får luta dig mot):
"""
${knowledge}
"""

Användarens fråga eller påstående:
"${message}"

Kom ihåg: Om dokumentet inte har svaret – säg att info saknas och föreslå nästa säkra steg. Småprat om mående är okej.
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",       // behåller din modell
        temperature: 0.25,     // låg för att minska gissningar
        max_tokens: 900,
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

    const reply = data.choices?.[0]?.message?.content || "Den informationen har jag tyvärr inte just nu.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
