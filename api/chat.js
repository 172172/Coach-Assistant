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

    // Alltid mentor/Jarvis-stil
    const styleDirective = `Mentor-stil (Jarvis): tydlig, pedagogisk och trygg. Håll dialog – fråga när info saknas.`

    const system = `
Du är "Coach Assistant" – mentor på en produktionslinje (t.ex. Linje 65). Ton: trygg, lugn, tydlig och hjälpsam.
Tekniska råd måste baseras på dokumentationen ("Kunskap").

DIALOGPOLICY (VIKTIGT):
- Om användarens fråga saknar kritiska parametrar (t.ex. vid sortbyte: dryck→dryck, storlek, burktyp, format, CIP?), be först om förtydligande.
  * Ställ MAX 1–2 korta följdfrågor.
  * Ge gärna enkla val som korta alternativ.
  * När du ber om förtydligande: fyll INTE "steps" ännu.
- Om det är en uppföljning och föregående tur innehöll din följdfråga, tolka nuvarande input som svar på den, och leverera fullständiga steg.
- Default: ge sammanfattning + korta steg. Fråga SEN om användaren vill ha förklaring (i stället för att alltid dumpa den).
- Gissa inte om täckningen är låg – säg att info saknas och föreslå säkra generella steg eller uppdatering av manualen.

SVARSFORMAT (STRIKT JSON):
{
  "summary": string,              // kort huvudpoäng
  "steps": string[],              // korta, görbara steg (om du har tillräcklig info)
  "explanation": string,          // fylls men klienten frågar först om den ska läsas upp
  "pitfalls": string[],
  "simple": string,
  "pro": string,
  "follow_up": string,            // fråga att ställa efter svaret (t.ex. "Vill du ha förklaringen?")
  "coverage": number,             // 0..1
  "matched_headings": string[],

  // Dialogtillägg:
  "needs_clarification": boolean, // true = fråga först
  "clarifying_question": string,  // kort, direkt fråga
  "clarifying_options": string[]  // valfria korta knapp/val-alternativ
}

Skriv ALLTID dessa fält. ${styleDirective}
`.trim();

    const prevBlock = prev && (prev.question || prev.assistant)
      ? `
Föregående tur (för uppföljningar):
- Tidigare fråga: ${prev.question || "(saknas)"}
- Ditt tidigare svar (JSON): ${JSON.stringify(prev.assistant || {}, null, 2)}
Om användaren nu ber om "förklara", "varför", "mer detaljer" etc. – leverera en tydlig förklaring baserat på föregående svar och manualens relevanta avsnitt.
` : "";

    const user = `
Kunskap (manual/arbetsplatsdokumentation):
"""
${knowledge}
"""

${prevBlock}

Användarens inmatning:
"${message}"

Instruktioner:
- Matcha relevanta rubriker och fyll "matched_headings".
- Skatta "coverage" mellan 0 och 1 (>=0.6 = god).
- Om nödvändigt: sätt "needs_clarification": true och ge "clarifying_question" + 2–5 "clarifying_options".
- När steg ges: håll dem korta och säkra. Fråga sen: "Vill du ha förklaringen?" via "follow_up".
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
        max_tokens: 1200,
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
        matched_headings: [],
        needs_clarification: false,
        clarifying_question: "",
        clarifying_options: []
      };
    }

    // Hård gate vid låg coverage
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
        matched_headings: structured.matched_headings || [],
        needs_clarification: false,
        clarifying_question: "",
        clarifying_options: []
      };
    }

    return res.status(200).json({ reply: structured });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
