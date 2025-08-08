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

    const { message = "", profile = null } = req.body || {};
    const knowledge = await getKnowledge();

    const persona = (profile && typeof profile === 'string') ? profile.trim() : null;
    const isKevin = persona && persona.toLowerCase() === 'kevin';

    const styleDirective = isKevin
      ? `Använd "Kevin-stil": extremt kort och enkel svenska, fokusera på 1) mycket kort förklaring och 2) en tydlig åtgärd.`
      : `Neutral mentor-stil: lugn, tydlig och pedagogisk; anpassa djupet efter frågan.`;

    const system = `
Du är "Coach Assistant" – mentor på en produktionslinje (t.ex. Linje 65). Ton: trygg, lugn, tydlig.
Du får föra lätt konversation (hälsa/mående), men tekniska råd måste vara baserade på dokumentationen.

HÅRDA REGLER:
- Ge endast tekniska/operativa råd som stöds av dokumentationen ("Kunskap") nedan.
- Om coverage är låg (mindre än 0.6) eller du inte hittar relevanta avsnitt: returnera ett svar som säger att information saknas och föreslå säkra generella steg eller att uppdatera manualen. Gissa inte.
- Svara i STRIKT JSON med fälten:
  {
    "summary": string,
    "steps": string[],
    "explanation": string,
    "pitfalls": string[],
    "simple": string,
    "pro": string,
    "follow_up": string,
    "coverage": number,                // 0..1, hur väl kunskapen täcker svaret
    "matched_headings": string[]       // t.ex. ["Avsnitt: Sortbyte Tapp"]
  }

Skriv alltid alla fält. ${styleDirective}
`.trim();

    const user = `
Kunskap (manual/arbetsplatsdokumentation):
"""
${knowledge}
"""

Användarens inmatning:
"${message}"

Instruktioner:
- Matcha relevanta rubriker i kunskapen och fyll "matched_headings".
- Skatta "coverage" mellan 0 och 1 (>=0.6 betyder god täckning).
- "simple" ska vara den enklaste möjliga förklaringen (passar nybörjare).
- "pro" ska vara mer teknisk och kompakt (för erfarna).
- Om "Kevin-stil" används: prioritera "simple" + konkret första åtgärd.
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.25,
        max_tokens: 950,
        response_format: { type: "json_object" }, // tvingar ren JSON
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

    // Försäkra strukturerat JSON som svar
    let content = data.choices?.[0]?.message?.content || "";
    let structured;
    try {
      structured = JSON.parse(content);
    } catch {
      structured = {
        summary: content || "Den informationen har jag tyvärr inte just nu.",
        steps: [],
        explanation: "",
        pitfalls: [],
        simple: content || "",
        pro: content || "",
        follow_up: "",
        coverage: 0,
        matched_headings: []
      };
    }

    // Hård gate vid låg coverage (<0.6)
    if (typeof structured.coverage !== 'number' || structured.coverage < 0.6) {
      structured = {
        summary: "Den informationen finns inte tillräckligt tydligt i manualen.",
        steps: [],
        explanation: "För säkerhets skull: följ generella säkra steg eller kontakta ansvarig. Vi bör uppdatera manualen.",
        pitfalls: [],
        simple: "Saknar täckning i manualen.",
        pro: "Saknar täckning i manualen.",
        follow_up: "Vill du att jag noterar att manualen behöver uppdateras för just detta?",
        coverage: 0,
        matched_headings: structured.matched_headings || []
      };
    }

    return res.status(200).json({ reply: structured });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
