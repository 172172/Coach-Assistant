// /api/chat.js
const KNOWLEDGE_URL = "https://raw.githubusercontent.com/172172/Coach-Assistant/main/assistant-knowledge.txt";
const CACHE_MS = 5 * 60 * 1000; // 5 min cache per serverless-instans

let knowledgeCache = { text: null, fetchedAt: 0 };

async function getKnowledge() {
  const now = Date.now();
  if (knowledgeCache.text && now - knowledgeCache.fetchedAt < CACHE_MS) {
    return knowledgeCache.text;
  }
  const res = await fetch(KNOWLEDGE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Misslyckades hämta kunskap: ${res.status}`);
  const text = await res.text();
  knowledgeCache = { text, fetchedAt: now };
  return text;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { message = "" } = req.body || {};
    const knowledge = await getKnowledge();

    const system = `Du är en mentor och coach på en produktionslinje. Du pratar alltid lugnt, tydligt och pedagogiskt – som om du lär upp en ny operatör. Allt du säger ska baseras endast på följande dokumentation från arbetsplatsen:

\"\"\"${knowledge}\"\"\"

Om frågan inte finns med i dokumentet ska du svara: "Den informationen har jag tyvärr inte just nu."`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o", // behåller din modell
        messages: [
          { role: "system", content: system },
          { role: "user", content: message }
        ],
        temperature: 0.2
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
