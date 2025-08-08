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
Ton: mycket lugn, tydlig och pedagogisk – som din bästa mentor (lite Jarvis-finess).
Bygg alltid ett sammanhängande svar – inte mening-för-mening.
Svara enligt denna struktur:
1) Kort sammanfattning (1–2 meningar).
2) Steg-för-steg-checklista (3–8 steg, konkreta handlingar).
3) Förklaring/varför (2–4 meningar, lätt svenska).
4) Vanliga fallgropar & tips (punktlista).
5) EN uppföljningsfråga på slutet för att guida vidare.

Begränsa dig till arbetsplatsens dokumentation nedan. Om svaret saknas, säg: "Den informationen har jag tyvärr inte just nu.".
`.trim();

    const user = `
Arbetsplatsens dokumentation:
"""
${knowledge}
"""

Användarens fråga:
"${message}"
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.3,
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
