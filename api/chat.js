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

// Heuristik för “sortbyte” och om användaren gett from→to-typ
function detectSortbyte(msg = "") {
  const t = (msg || "").toLowerCase();
  const isSort = /sort\s*byte|sortbyte|byt[aä]\s*sort|byte i tappen|byta sort|sortbyten?/.test(t);
  const hasTypeHint = /(öl|lager|ale|stout|ipa|läsk|soda|vatten|juice|cider|energi|sirap|syrup|smak|kolsyrad|still)/.test(t);
  return { isSort, hasTypeHint };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", profile = null, prev = null } = req.body || {};
    const knowledge = await getKnowledge();

    const { isSort, hasTypeHint } = detectSortbyte(message);

    // --- SYSTEMPROMPT ---
    const system = `
Du är "Coach Assistant" – en mentor på produktionslinjen (t.ex. Linje 65).
Ton: trygg, lugn, pedagogisk, naturlig och mänsklig. Var inte stel.

ABSOLUTA REGLER
- Ge endast tekniska/operativa råd som stöds av dokumentationen ("Kunskap") nedan.
- Om täckning ("coverage") är < 0.6 eller relevanta avsnitt saknas: säg tydligt att info saknas och ge säkra, generella steg eller be om att uppdatera manualen.
- Svara i EXAKT JSON enligt schemat längre ned. Ingen prosa utanför JSON.

DIALOG- & COACHNINGSPOLICY
- Fråga alltid om förtydligande när input är för vag för att kunna ge korrekt svar (ställ EN tydlig fråga + 2–5 korta val).
- Tala naturligt. Använd korta meningar och “pausord” ibland (men inga emojis). 
- I "spoken": prata som till en kollega: varm, lugn, tydlig, och säg t.ex. ”säg till om du vill att jag tar det steg för steg”.

FÖR "SORTBYTE" (och relaterade tapp/fyllare-bitar)
- Om användaren inte specificerat typ (t.ex. läsk→öl / öl→öl), returnera en klarifiering:
  need = { clarify: true, question: "...", options: ["Läsk → läsk", "Läsk → öl", "Öl → öl", "Öl → läsk"] }.
  spoken: ställ frågan naturligt (“För att göra rätt behöver jag veta…”).
- När typ är känd: gå in i COACH-LÄGE och ge lugna, tydliga steg som täcker förberedelser, säkringar, switch/flush/CIP (endast om manualen beskriver det), kontroller, och återstart.
  * Steg ska vara numrerade, konkreta och inte hopklippta. 8–20 steg är ok om manualen täcker dem.
  * Markera kontroller (“verifiera tryck/temperatur/flöde enligt manualen” etc.) när manualen nämner dem.
  * Lägg ev. till korta mikro-pausfrågor i spoken (“redo för nästa del?”) men håll dig till manualen.
- Hitta och fyll "matched_headings" med rubrikerna från manualen som stödjer stegen.

JSON-SCHEMA (måste följas exakt):
{
  "spoken": string,                            // det du säger högt (naturligt)
  "need": { "clarify": boolean, "question"?: string, "options"?: string[] },
  "cards": {
    "summary": string,
    "steps": string[],
    "explanation": string,
    "pitfalls": string[],
    "simple": string,
    "pro": string,
    "follow_up": string,
    "coverage": number,                        // 0..1 hur väl manualen täcker svaret
    "matched_headings": string[]
  },
  "follow_up": string
}

VIKTIGT
- Hitta rubriker i manualen och fyll matched_headings.
- “simple” = nybörjarvänlig förklaring. “pro” = kompakt teknisk version.
- Säg aldrig påhittade siffror/parametrar. Om manualen inte anger ett värde, håll det generellt (“enligt manualens gränsvärden”).
- Om coverage < 0.6: presentera INTE operativa steg. Förklara att manualen behöver uppdateras.
`.trim();

    // --- USERPROMPT ---
    const user = `
Kunskap (manual/arbetsplatsdokumentation):
"""
${knowledge}
"""

Användarens inmatning:
"${message}"

Tidigare kontext:
${prev ? JSON.stringify(prev) : "null"}

Instruktioner för din output:
- Om frågan rör sortbyte men saknar typ, returnera en "need.clarify" som beskrivet.
- Annars: ge full coachning med tydliga steg enligt manualen.
- Fyll ALLA fält i JSON-schemat. 
`.trim();

    // --- OpenAI ---
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.2,
        max_tokens: 1400,
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

    // --- Försök tolka strukturen ---
    let content = data.choices?.[0]?.message?.content || "";
    let out;
    try {
      out = JSON.parse(content);
    } catch {
      // Minimalt fallback-objekt
      out = {
        spoken: content || "Jag saknar tydlig information för att guida dig.",
        need: { clarify: false },
        cards: {
          summary: content || "—",
          steps: [],
          explanation: "",
          pitfalls: [],
          simple: content || "",
          pro: content || "",
          follow_up: "",
          coverage: 0,
          matched_headings: []
        },
        follow_up: ""
      };
    }

    // --- Extra säkerhet: tvinga klarifiering vid otydligt sortbyte ---
    if (isSort && !hasTypeHint && !(out?.need?.clarify)) {
      out.need = {
        clarify: true,
        question: "Vilket sortbyte gäller? (så guidar jag exakt enligt manualen)",
        options: ["Läsk → läsk", "Läsk → öl", "Öl → öl", "Öl → läsk"]
      };
      out.spoken = "För att göra rätt behöver jag veta vilket sortbyte det gäller. Är det läsk till läsk, läsk till öl, öl till öl eller öl till läsk?";
    }

    // --- Gatekeeping: om coverage låg → inga operativa steg ---
    const cov = Number(out?.cards?.coverage ?? out?.coverage ?? 0);
    if (cov < 0.6) {
      out.cards = out.cards || {};
      out.cards.summary = "Den informationen finns inte tillräckligt tydligt i manualen.";
      out.cards.steps = [];
      out.cards.explanation = "För att vara säker, följ generella säkra rutiner eller kontakta ansvarig. Vi bör uppdatera manualen med detta.";
      out.cards.pitfalls = [];
      out.cards.simple = out.cards.summary;
      out.cards.pro = out.cards.summary;
      out.cards.follow_up = "Vill du att jag noterar att manualen behöver uppdateras för just detta?";
      out.cards.coverage = cov;
      out.cards.matched_headings = Array.isArray(out.cards.matched_headings) ? out.cards.matched_headings : [];
      // Gör spoken tydlig men kort i detta läge
      out.spoken = "Jag saknar täckning i manualen för att guida säkert. Vill du att vi uppdaterar manualen eller tar generella säkra steg?";
      out.need = out.need || { clarify: false };
      out.follow_up = out.cards.follow_up;
    }

    return res.status(200).json({ reply: out });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
