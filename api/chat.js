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

    const system = `
Du är "Coach Assistant" – mentor på en produktionslinje (t.ex. Linje 65).
Ton: trygg, lugn, pedagogisk, naturlig och mänsklig. Var inte stel.

ABSOLUTA REGLER
- Ge endast tekniska/operativa råd som stöds av dokumentationen ("Kunskap") nedan.
- Om täckning ("coverage") är < 0.4 ELLER du inte hittar relevanta rubriker: säg tydligt att info saknas och ge säkra, generella steg eller be om att uppdatera manualen.
- Svara i EXAKT JSON enligt schemat längre ned. Ingen prosa utanför JSON.

DIALOG- & COACHNING
- Fråga om förtydligande när input är för vag (EN tydlig fråga + 2–5 korta val).
- "spoken": prata som till en kollega: varm, lugn, tydlig. Säg gärna “säg till om du vill ha nästa del”.

FÖR "SORTBYTE" (tapp/fyllare)
- Om typ saknas (t.ex. läsk→öl / öl→öl): returnera klarifiering med:
  need = { clarify: true, question: "...", options: ["Läsk → läsk", "Läsk → öl", "Öl → öl", "Öl → läsk"] }.
  spoken: ställ frågan naturligt.
- När typ finns: ge lugna, tydliga, NUMRERADE steg (förbered, säkra, switch/flush/CIP enligt manual, kontroller, återstart). 8–20 steg är OK om manualen täcker det.
- Markera kontroller (tryck/temperatur/flöde osv.) bara om manualen nämner dem.
- Fyll "matched_headings" med EXAKTA rubriksträngar från manualen som stöder stegen.

COVERAGE–GUIDE (var realistisk, inte överförsiktig)
- ≥ 0.75: Minst 2 relevanta rubriker täcker exakt uppgiften + dina steg kommer direkt därifrån.
- ~0.6–0.75: 1–2 rubriker delvis relevanta; du fyller luckor med allmänt säkra formuleringar (utan egna siffror).
- ~0.4–0.6: Det finns något stöd, men inte komplett; var försiktig och uppmana att verifiera mot manualen.
- ≤ 0.4: För litet stöd → ge INTE operativa steg.

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
- Säg aldrig påhittade siffror/parametrar. Om manualen inte anger ett värde, håll det generellt (“enligt manualens gränsvärden”).
- “simple” = nybörjarvänlig, “pro” = kompakt teknisk.
- Om coverage hamnar ~0.5: leverera steg men påminn om att verifiera mot manualens rubriker du listat.
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

Output-instruktion:
- Om frågan rör sortbyte men saknar typ, returnera en "need.clarify".
- Annars: ge full coachning med lugna, numrerade steg enligt manualen.
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
        max_tokens: 1600,
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

    // --- Tolka JSON ---
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

    // Extra säkerhet: tvinga klarifiering vid otydligt sortbyte
    if (isSort && !hasTypeHint && !(out?.need?.clarify)) {
      out.need = {
        clarify: true,
        question: "Vilket sortbyte gäller? (så guidar jag exakt enligt manualen)",
        options: ["Läsk → läsk", "Läsk → öl", "Öl → öl", "Öl → läsk"]
      };
      out.spoken = "För att göra rätt behöver jag veta vilket sortbyte det gäller. Är det läsk till läsk, läsk till öl, öl till öl eller öl till läsk?";
    }

    // --- Gate med tre nivåer ---
    const cov = Number(out?.cards?.coverage ?? out?.coverage ?? 0);
    const heads = Array.isArray(out?.cards?.matched_headings) ? out.cards.matched_headings : [];

    // HÅRT STOPP: väldigt låg täckning eller inga rubriker
    if (cov < 0.4 || heads.length === 0) {
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
      out.spoken = "Jag saknar täckning i manualen för att guida säkert. Ska vi uppdatera manualen eller ta generella säkra steg?";
      out.need = out.need || { clarify: false };
      out.follow_up = out.cards.follow_up;
    }
    // Mjuk varning: delvis täckning → tillåt steg men bekräfta verifiering
    else if (cov < 0.6) {
      // Låt stegen vara kvar, men förstärk spoken + follow_up
      const warn = "Jag guidar enligt närmaste relevanta avsnitt — dubbelkolla gärna mot rubrikerna jag visar.";
      out.spoken = out.spoken ? `${out.spoken} ${warn}` : warn;
      out.cards.follow_up = out.cards.follow_up || "Vill du att jag bryter ner nästa del, eller öppnar rubrikerna i manualen?";
      out.follow_up = out.follow_up || "Säg till om du vill att jag läser upp nästa steg.";
      // säkerställ att coverage ligger kvar som modellens värde
      out.cards.coverage = cov;
    } else {
      // OK täckning, bara säkerställ att fälten finns
      out.cards.coverage = cov;
      out.cards.matched_headings = heads;
    }

    return res.status(200).json({ reply: out });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
