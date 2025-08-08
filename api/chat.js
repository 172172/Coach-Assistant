// /api/chat.js
const KNOWLEDGE_URL = "https://raw.githubusercontent.com/172172/Coach-Assistant/main/assistant-knowledge.txt";
const CACHE_MS = 5 * 60 * 1000; // 5 min

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

    const { message = "", mode = "pedagogiskt", history = [], explainStepIndex = null, lastSteps = null } = req.body || {};
    const knowledge = await getKnowledge();

    // Styles
    const style = mode === "snabbt"
      ? "Svara väldigt kort. Max 5 punkter."
      : "Var pedagogisk, lugn och tydlig. Ge steg-för-steg, bekräftelser och enkla förklaringar.";

    // När vi förklarar ett specifikt steg
    const explainPart = explainStepIndex !== null && Array.isArray(lastSteps)
      ? `Använd denna steglista från föregående svar:
${lastSteps.map((s,i)=>`${i+1}. ${s}`).join("\n")}
Förklara ENDAST steg ${explainStepIndex+1} enkelt, med analogier vid behov.`
      : "";

    const system = `
Du är "Coach Assistant" – mentor på en produktionslinje (t.ex. Linje 65).
Ton: varm, lugn, trygg, professionell. Anpassa nivån efter användaren.
Allt du säger ska så långt som möjligt baseras på kunskapen nedan. Om det saknas, säg tydligt att du saknar info.

Krav på svar:
- Inled med en kort sammanfattning.
- Ge en checklista med konkreta steg i rätt ordning (om relevant).
- Peka ut vanliga fallgropar.
- Ställ EN uppföljningsfråga om läge/observationsdata för att guida rätt.
- Om risk/säkerhet: nämn försiktighetsåtgärder.
- Returnera i strikt JSON med fälten: { "reply": string, "steps": string[] }.
${style}
`.trim();

    const user = `
Kunskapsbas:
"""
${knowledge}
"""

${explainPart}

Användarens fråga eller kontext:
"${message}"
`.trim();

    // bygg meddelandelista från historik (begränsa längd)
    const msgs = [{ role: "system", content: system }];
    // inkludera lite historik (bara text)
    const trimmed = Array.isArray(history) ? history.slice(-8) : [];
    trimmed.forEach(m => {
      if (m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant")) {
        msgs.push({ role: m.role, content: m.content });
      }
    });
    msgs.push({ role: "user", content: user });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",      // behåll modellen
        temperature: 0.3,
        max_tokens: 900,
        messages: msgs,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("OpenAI chat error:", data);
      return res.status(500).json({ error: "Chat API error", details: data });
    }

    let content = data.choices?.[0]?.message?.content || "";
    // Försök säkerställa JSON – om modellen råkar svara med text
    let structured = null;
    try {
      structured = JSON.parse(content);
      if (typeof structured !== "object" || structured === null) throw new Error("Not object");
      if (!("reply" in structured)) throw new Error("Missing reply");
    } catch {
      // fallback: kapsla i JSON
      structured = { reply: content, steps: [] };
    }

    return res.status(200).json({ reply: structured });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
