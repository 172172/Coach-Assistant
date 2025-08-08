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

// Enkel detektor för "sortbyte"-frågor
function isSortbyteQuery(msg = "") {
  const t = (msg || "").toLowerCase();
  return /sort\s*byte|sortbyte|byt[aä]\s*sort|byte i tappen|byta sort|sortbyten?/.test(t);
}
function hasTypeHint(msg = "") {
  const t = (msg || "").toLowerCase();
  return /(öl|lager|ale|stout|ipa|läsk|soda|vatten|juice|cider|energi|sirap|syrup|smak|kolsyrad|still)/.test(t);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null } = req.body || {};
    const knowledge = await getKnowledge();

    const system = `
Du är "Coach Assistant" – mentor på produktionslinjen (t.ex. Linje 65).
Ton: varm, lugn, naturlig och pedagogisk (inte stel). Tala som till en kollega.

HÅRDA REGLER
- Ge endast tekniska/operativa råd som stöds av dokumentationen ("Kunskap").
- Svara i EXAKT JSON enligt schemat längre ned. Ingen text utanför JSON.
- Om täckning ("coverage") är väldigt låg (< 0.25) ELLER inga relevanta rubriker kan hittas alls: säg att info saknas och ge endast säkra generella steg/förslag att uppdatera manualen.

DIALOG & COACHNING
- Om frågan är för vag: ställ EN tydlig följdfråga. Lista **inte** påhittade val – använd öppna frågor om manualen inte anger tydliga kategorier.
- I "spoken": låt det låta mänskligt: "vi tar det steg för steg", "säga till när du är redo för nästa del".

FÖR "SORTBYTE" (tapp/fyllare)
- Om användaren inte specificerat typ (t.ex. läsk→öl eller läsk→läsk): be kort om förtydligande med **öppen fråga** (utan egna val), t.ex. "Vilken produkt går du från – och till?".
- När typ är känd: ge **lugna, numrerade steg** (förberedelser, säkringar, switch/flush/CIP *endast om manualen nämner det*, kontroller, återstart). 8–20 steg är ok om manualen täcker det.
- Markera kontroller och säkerhet endast om manualen anger dem.
- Fyll "matched_headings" med rubriker från manualen som stöder stegen (exakta rubriksträngar).

COVERAGE-KALIBRERING (var realistisk)
- ≥ 0.75: Flera rubriker matchar direkt uppgiften; stegen kommer därifrån.
- 0.6–0.75: Delvis stöd; använd generella formuleringar utan egna siffror.
- 0.4–0.6: Viss relevans; leverera steg men be användaren verifiera mot rubrikerna du listar.
- < 0.4: För svagt; avstå från detaljerade steg.

JSON-SCHEMA (måste följas exakt):
{
  "spoken": string,
  "need": { "clarify": boolean, "question"?: string, "options"?: string[] },
  "cards": {
    "summary": string,
    "steps": string[],
    "explanation": string,
    "pitfalls": string[],
    "simple": string,
    "pro": string,
    "follow_up": string,
    "coverage": number,
    "matched_headings": string[]
  },
  "follow_up": string
}

VIKTIGT
- Säg aldrig egna siffror/parametrar. Om manualen saknar värden: håll det generellt (“enligt manualens gränsvärden”).
- “simple” = nybörjarvänlig, “pro” = kompakt teknisk.
- Vid sortbyte: försök ge minst 10 tydliga steg om manualen tillåter. 
`.trim();

    const user = `
Kunskap (manual/arbetsplatsdokumentation):
"""
${knowledge}
"""

Användarens inmatning:
"${message}"

Tidigare kontext:
${prev ? JSON.stringify(prev) : "null"}

Instruktioner:
- Om frågan rör sortbyte och typ saknas: returnera need.clarify=true med en **öppen fråga** (inga options om manualen inte listar dem).
- Annars: ge full coachning med numrerade steg enligt manualen.
- Fyll ALLA fält i JSON-schemat. 
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.2,
        max_tokens: 1800,
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

    // Försök tolka strukturen
    let content = data.choices?.[0]?.message?.content || "";
    let out;
    try {
      out = JSON.parse(content);
    } catch {
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

    // Om det är en sortbyte-fråga utan typ, se till att vi ställer öppen fråga (inga hårdkodade options)
    if (isSortbyteQuery(message) && !hasTypeHint(message)) {
      if (!out?.need?.clarify) {
        out.need = { clarify: true, question: "Vilken produkt går du från – och till? (t.ex. läsk till läsk)", options: [] };
        out.spoken = "För att guida rätt behöver jag veta vilken produkt du byter från – och till. Säg det så tar vi det steg för steg.";
      } else {
        // Rensa bort ev. påhittade options från modellen om den ändå gissade
        if (Array.isArray(out.need.options) && out.need.options.length > 0) {
          out.need.options = []; // lämna bara öppen fråga
        }
      }
    }

    // Mjuk coverage-boost om vi faktiskt har rubriker + flera steg
    const steps = Array.isArray(out?.cards?.steps) ? out.cards.steps : [];
    const heads = Array.isArray(out?.cards?.matched_headings) ? out.cards.matched_headings : [];
    let cov = Number(out?.cards?.coverage ?? out?.coverage ?? 0);

    const hl = heads.map(h => String(h || "").toLowerCase());
    const looksLikeSort = hl.some(h => h.includes("sort") || h.includes("tapp") || h.includes("cip") || h.includes("byte"));
    if (looksLikeSort && steps.length >= 6) cov = Math.max(cov, 0.58);
    if (looksLikeSort && steps.length >= 10) cov = Math.max(cov, 0.65);

    // Gate med tre nivåer
    if (cov < 0.25 || (heads.length === 0 && steps.length < 4)) {
      // Hårt stopp: väldigt låg täckning
      out.cards = out.cards || {};
      out.cards.summary = "Den informationen finns inte tillräckligt tydligt i manualen.";
      out.cards.steps = [];
      out.cards.explanation = "Följ generella säkra rutiner eller kontakta ansvarig. Vi bör uppdatera manualen med detta.";
      out.cards.pitfalls = [];
      out.cards.simple = out.cards.summary;
      out.cards.pro = out.cards.summary;
      out.cards.follow_up = "Vill du att jag noterar att manualen behöver uppdateras för just detta?";
      out.cards.coverage = cov || 0;
      out.cards.matched_headings = heads;
      out.spoken = "Jag saknar täckning i manualen för att guida säkert. Vill du att vi tar generella säkra steg eller uppdaterar manualen?";
      out.need = out.need || { clarify: false };
      out.follow_up = out.cards.follow_up;
    } else if (cov < 0.6) {
      // Mjuk varning: leverera steg, men be om verifiering
      out.cards.coverage = cov;
      out.cards.matched_headings = heads;
      const warn = "Jag guidar enligt närmaste relevanta avsnitt—verifiera gärna mot rubrikerna jag visar.";
      out.spoken = out.spoken ? `${out.spoken} ${warn}` : warn;
      out.cards.follow_up = out.cards.follow_up || "Vill du att jag bryter ner nästa del?";
      out.follow_up = out.follow_up || "Säg till när du vill ha nästa steg.";
    } else {
      // OK täckning
      out.cards.coverage = cov;
      out.cards.matched_headings = heads;
    }

    return res.status(200).json({ reply: out });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
