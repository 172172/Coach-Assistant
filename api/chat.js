// /api/chat.js
// Fri språkstil, låst mot manualen. Bara EN mild gate: stoppa enbart om
// det verkligen saknas underlag (inga rubriker + nästan inga steg).

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

    const { message = "", prev = null } = req.body || {};
    const knowledge = await getKnowledge();

    // --- SYSTEMPROMPT (mjuk) ---
    const system = `
Du är "Coach Assistant" – varm, lugn, pedagogisk, pratar som en kollega.
Var fri i språket men bygg ALL teknik på "Kunskap" (manualen) nedan.

Regler:
- Om underlaget är oklart: ställ EN tydlig följdfråga (öppen) för att få rätt kontext.
- Finns det MINSTA relevanta underlag i manualen: ge lugna, NUMRERADE steg (gärna 8–20 om manualen räcker) + kort sammanfattning.
- Hitta och lista de rubriker i manualen du faktiskt använder i "matched_headings".
- Uppfinn aldrig siffror/parametrar. Saknas värden i manualen → håll det generellt (“enligt manualens gränsvärden”).
- Rapportera coverage realistiskt, men säg inte “saknar täckning” i spoken om det ändå går att guida säkert.

Returnera EXAKT JSON (ingen text utanför):
{
  "spoken": string,                            // naturligt talat svar (mänskligt)
  "need": { "clarify": boolean, "question"?: string },
  "cards": {
    "summary": string,
    "steps": string[],                         // numrerade steg som text
    "explanation": string,
    "pitfalls": string[],
    "simple": string,
    "pro": string,
    "follow_up": string,
    "coverage": number,                        // 0..1
    "matched_headings": string[]               // exakta rubriker ur manualen
  },
  "follow_up": string
}

Coverage-guide:
- ~0.75+: flera direkt relevanta rubriker, steg kommer därifrån.
- ~0.6–0.75: delvis stöd; komplettera med säkra generella formuleringar.
- ~0.4–0.6: viss relevans; leverera steg och be att verifiera mot rubrikerna.
- <0.2: för tunt → be om mer info eller säg att manualen behöver uppdateras.
`.trim();

    // --- USERPROMPT ---
    const user = `
Kunskap (manual – fulltext):
"""
${knowledge}
"""

Användarens inmatning:
"${message}"

Tidigare tur (för kontext, om relevant):
${prev ? JSON.stringify(prev) : "null"}

Instruktion:
- Om frågan är för vag: returnera need.clarify=true med en kort ÖPPEN fråga (inga påhittade alternativ).
- Annars: ge tydliga, lugna, NUMRERADE steg enligt manualen. Lista korrekta matched_headings.
- Fyll ALLA fält i JSON-schemat. Ingen text utanför JSON.
`.trim();

    // --- OpenAI-anrop ---
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.25,
        max_tokens: 2000,
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

    // --- Förvänta strikt JSON, men ha safe fallback ---
    let content = data.choices?.[0]?.message?.content || "";
    let out;
    try {
      out = JSON.parse(content);
    } catch {
      out = {
        spoken: "Jag behöver lite mer info för att guida rätt. Vad exakt vill du göra?",
        need: { clarify: true, question: "Vad exakt vill du göra?" },
        cards: {
          summary: "Behöver mer kontext.",
          steps: [],
          explanation: "",
          pitfalls: [],
          simple: "",
          pro: "",
          follow_up: "",
          coverage: 0,
          matched_headings: []
        },
        follow_up: ""
      };
    }

    // --- Mjuk hantering efter modellen ---
    const cov   = Number(out?.cards?.coverage ?? 0);
    const heads = Array.isArray(out?.cards?.matched_headings) ? out.cards.matched_headings : [];
    const steps = Array.isArray(out?.cards?.steps) ? out.cards.steps : [];

    // 1) Om modellen vill ha förtydligande → returnera direkt (ingen gate).
    if (out?.need?.clarify) {
      out.cards.coverage = cov || 0;
      return res.status(200).json({ reply: out });
    }

    // 2) Enda riktiga stoppet: verkligen inget att stå på.
    if ((heads.length === 0) && (steps.length < 2)) {
      out.spoken = "Manualen är för tunn för att jag ska kunna guida säkert. Vill du att jag tar generella säkra steg, eller att vi uppdaterar manualen?";
      out.cards.summary = "Otillräckligt underlag i manualen för detaljerade steg.";
      out.cards.steps = [];
      out.cards.explanation = "Följ generella säkra rutiner eller kontakta ansvarig. Uppdatera manualen för detta moment.";
      out.cards.pitfalls = [];
      out.cards.simple = out.cards.summary;
      out.cards.pro = out.cards.summary;
      out.cards.follow_up = "Vill du att jag noterar ett behov av uppdatering i manualen?";
      out.cards.coverage = cov || 0;
      return res.status(200).json({ reply: out });
    }

    // 3) I alla andra fall: låt modellen tala fritt men kunskapsbaserat.
    out.cards.coverage = cov || out.cards.coverage || 0;
    out.cards.matched_headings = heads || out.cards.matched_headings || [];
    return res.status(200).json({ reply: out });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
