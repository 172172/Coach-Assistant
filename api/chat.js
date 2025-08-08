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

// -------- helpers --------
function normalize(s = "") {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // ta bort diakritiska
    .replace(/ö/g,"o").replace(/ä/g,"a").replace(/å/g,"a")
    .replace(/\s+/g," ").trim();
}
function isSortbyteQuery(msg = "") {
  const t = normalize(msg);
  return /(sort\s*byte|sortbyte|byta sort|byte i tappen|sortbyten?)/.test(t);
}
function hasTypeHint(msg = "") {
  const t = normalize(msg);
  return /(ol|lager|ale|stout|ipa|lask|soda|vatten|juice|cider|energi|sirap|syrup|smak|kolsyrad|still)/.test(t);
}
function extractTypePair(msg = "") {
  const t = normalize(msg);
  // “fran X till Y” eller “X -> Y” eller “X till Y”
  const m = t.match(/(?:fran\s+)?([a-z0-9\-]+)\s*(?:->|→|till)\s*([a-z0-9\-]+)/i);
  if (m) return { from: m[1], to: m[2], hasPair: true };
  return { from: null, to: null, hasPair: false };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null } = req.body || {};
    const knowledge = await getKnowledge();

    const sortIntent = isSortbyteQuery(message);
    const typeHint = hasTypeHint(message);
    const pair = extractTypePair(message);

    // --- SYSTEM ---
    const system = `
Du är "Coach Assistant" – mentor på produktionslinjen (t.ex. Linje 65).
Ton: varm, lugn, naturlig, pedagogisk. Tala som till en kollega.

ABSOLUT:
- Råd måste stödas av "Kunskap" (manual).
- Svara i EXAKT JSON enligt schemat. Ingen text utanför JSON.
- Hårt stopp endast vid mycket låg täckning (<0.25) eller när inga relevanta rubriker hittas.

DIALOG:
- Om frågan är för vag: ställ EN tydlig följdfråga (öppen frågeform, inga påhittade val).
- I "spoken": naturligt och lugnt. Erbjud att ta det stegvis.

SORTBYTE:
- Om typ saknas: be med öppen fråga: "Vilken produkt går du från – och till?"
- När typ finns: ge lugna, numrerade steg (förberedelser, säkringar, switch/flush/CIP om manualen nämner det, kontroller, återstart).
  * 8–20 steg är OK om manualen täcker.
  * Lista exakta rubrikträffar i "matched_headings".
  * Inga påhittade siffror – använd generella formuleringar om manualen saknar värden.

COVERAGE-KALIBRERING:
- ≥0.75: flera starka rubriker direkt relevanta.
- 0.6–0.75: delvis stöd; generella formuleringar OK.
- 0.4–0.6: viss relevans; leverera steg men uppmana att verifiera mot rubrikerna.
- <0.25: för svagt → ingen detaljerad vägledning.

JSON-SCHEMA:
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
`.trim();

    // --- USER ---
    const user = `
Kunskap (manual):
"""
${knowledge}
"""

Användarens inmatning:
"${message}"

Typ-hint:
${pair.hasPair ? `${pair.from} → ${pair.to}` : (typeHint ? "typ nämnd" : "saknas")}

Krav:
- Om sortbyte men typ saknas: returnera need.clarify=true med öppen fråga (inga options).
- Om typ finns: ge lugna, numrerade steg enligt manualen. Var utförlig.
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

    let content = data.choices?.[0]?.message?.content || "";
    let out;
    try { out = JSON.parse(content); }
    catch {
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

    // ---- PHASE 1: Klarifiering prioriteras (ingen gate här) ----
    if (sortIntent && !typeHint && !pair.hasPair) {
      // Tvinga öppen fråga om modellen inte redan gjorde det
      if (!out?.need?.clarify) {
        out.need = { clarify: true, question: "Vilken produkt går du från – och till? (ex: läsk till läsk)", options: [] };
        out.spoken = "För att guida rätt behöver jag veta vilken produkt du byter från – och till. Säg det så tar vi det steg för steg.";
      } else {
        // säkerställ att spoken är själva frågan
        out.spoken = out.need.question || "Vilken produkt går du från – och till?";
        if (Array.isArray(out.need.options) && out.need.options.length) out.need.options = []; // inga påhittade val
      }
      // Skicka tillbaka direkt – ingen coverage-gate vid klarifiering
      return res.status(200).json({ reply: out });
    }

    // ---- PHASE 2: Vi har typ → tillåt coachning, men gate:a mjukt ----
    const steps = Array.isArray(out?.cards?.steps) ? out.cards.steps : [];
    const heads = Array.isArray(out?.cards?.matched_headings) ? out.cards.matched_headings : [];
    let cov = Number(out?.cards?.coverage ?? out?.coverage ?? 0);

    // Bump vid sortbyte + substans (minimera falsk-negativ “saknar täckning”)
    if (sortIntent) {
      if (steps.length >= 8) cov = Math.max(cov, 0.62);
      if (heads.length >= 1 && steps.length >= 6) cov = Math.max(cov, 0.65);
    }

    // HÅRT STOPP endast om det verkligen saknas
    if (cov < 0.25 || (heads.length === 0 && steps.length < 4)) {
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
      return res.status(200).json({ reply: out });
    }

    // Mjuk varning 0.25–0.6 → behåll steg men be om verifiering
    if (cov < 0.6) {
      out.cards.coverage = cov;
      out.cards.matched_headings = heads;
      const warn = "Jag guidar enligt närmaste relevanta avsnitt — dubbelkolla gärna mot rubrikerna jag visar.";
      out.spoken = out.spoken ? `${out.spoken} ${warn}` : warn;
      out.cards.follow_up = out.cards.follow_up || "Vill du att jag bryter ner nästa del?";
      out.follow_up = out.follow_up || "Säg till när du vill ha nästa steg.";
      return res.status(200).json({ reply: out });
    }

    // OK täckning
    out.cards.coverage = cov;
    out.cards.matched_headings = heads;
    return res.status(200).json({ reply: out });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
