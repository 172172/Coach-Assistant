// /api/chat.js
// Öppna samtal om "allt" (GENERAL), men för linje/produktion (LINE) är manualen enda sanningen.
// Inga procedurer/kvalitet/säkerhet/felsökning/parametrar utan rubriker i manualen.

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

// -------- Heuristik (server-side dubbelsäkring) --------
const norm = (s="") => s.toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/ö/g,"o").replace(/ä/g,"a").replace(/å/g,"a")
  .replace(/\s+/g," ").trim();

function isLineTopic(s="") {
  const t = norm(s);
  // Träffar på produktion, tapp, CIP, kvalitet, säkerhet, maskin, parametrar, felsökning etc.
  return /linj|tapp|fyll|sortbyte|byte i tappen|cip|skolj|flush|rengor|sanit|recept|batch|oee|smed|hmi|plc|starta|stoppa|felsok|alarm|tryck|temperatur|flode|ventil|pump|kvalitet|prov|qc|haccp|ccp|sakerhet|underhall|smorj|toque|moment|kalibr|setup|omst|omställ|stopporsak|setpoint|saetpunkt|spak|vent|pack|etikett|kapsyl|burk|linje/.test(t);
}

function prevLooksLine(prev) {
  if (!prev) return false;
  const q = norm(prev.question||"");
  const a = JSON.stringify(prev.assistant||{}).toLowerCase();
  return isLineTopic(q) || /"domain"\s*:\s*"line"/.test(a) || /matched_headings/i.test(a);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null } = req.body || {};
    const knowledge = await getKnowledge();

    // -------- Systemprompt --------
    const system = `
Du är en AI-assistent skapad av Kevin – tänk Douglas Adams möter JARVIS.
Prata ALLTID på svenska. Var vänlig, kvick och mänsklig, men håll dig till fakta.

DU HAR TVÅ LÄGEN:
1) "GENERAL" – fritt snack om världen, teknik, sport, filosofi, skämt etc. Du får använda allmän kunskap. Personlighet: lättsam, kvick, kort men innehållsrik.
2) "LINE" – allt som kan påverka produktion/linje (procedurer, kvalitet, säkerhet, underhåll, felsökning, parametrar, tapp/CIP). Här är manualen ("Kunskap") den ENDA källan.
   - Ge endast råd som stöds av manualen.
   - Om manualen är otydlig eller saknas: be om förtydligande ELLER säg att det inte täcks och föreslå att uppdatera manualen. Hitta inte på.
   - Inga externa siffror/parametrar/”best practise” utanför manualen.

KLASSA FÖRST:
- Sätt "meta.domain": "line" om frågan rör drift, procedurer, kvalitet, säkerhet, felsökning, maskin/parametrar, CIP/tapp etc. Annars "general".
- Hitta rubriker i manualen du faktiskt lutar dig mot och fyll "matched_headings".
- Sätt "coverage" realistiskt utifrån hur väl manualen täcker svaret.

STIL:
- GENERAL: Douglas+JARVIS vibe, kort, charmigt, kvickt.
- LINE: trygg, lugn, pedagogisk coach. Tydliga, numrerade steg när det behövs. Inga skämt som stör säkerhet.

SVARSFORMAT (EXAKT JSON, ingen text utanför):
{
  "meta": { "domain": "line" | "general" },
  "spoken": string,
  "need": { "clarify": boolean, "question"?: string },
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

COVERAGE-GUIDE:
- ≥0.75: flera relevanta rubriker, steg direkt därifrån.
- 0.6–0.75: delvis stöd; komplettera med säkra generella formuleringar (utan nya siffror).
- 0.4–0.6: viss relevans; leverera steg men be användaren verifiera mot rubrikerna.
- <0.3: troligen otillräckligt – fråga om förtydligande eller säg att manualen saknas.
`.trim();

    // -------- Userprompt --------
    const user = `
Kunskap (manual – fulltext):
"""
${knowledge}
"""

Tidigare tur (för kontext):
${prev ? JSON.stringify(prev) : "null"}

Användarens inmatning:
"${message}"

Instruktion:
- Klassificera "meta.domain".
- Om domain="line" och manualen ger stöd: ge lugna, numrerade steg och lista matched_headings.
- Om domain="line" och manual saknas/delvis: ställ en öppen följdfråga (need.clarify=true) ELLER säg att manualen saknas och föreslå uppdatering. Hitta inte på.
- Om domain="general": svara fritt enligt persona.
- Fyll ALLA fält i JSON-schemat.
`.trim();

    // -------- OpenAI --------
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.3,
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

    // -------- Parse & fallback --------
    let content = data.choices?.[0]?.message?.content || "";
    let out;
    try { out = JSON.parse(content); }
    catch {
      out = {
        meta: { domain: isLineTopic(message) || prevLooksLine(prev) ? "line" : "general" },
        spoken: "Oj, där tappade jag tråden. Kan du säga om det här gäller linjen eller är en allmän fråga?",
        need: { clarify: true, question: "Gäller det linjen (procedur/kvalitet/säkerhet) eller är det allmänt?" },
        cards: {
          summary: "Behöver veta om det är LINE eller GENERAL.",
          steps: [], explanation: "", pitfalls: [],
          simple: "", pro: "", follow_up: "",
          coverage: 0, matched_headings: []
        },
        follow_up: ""
      };
    }

    // -------- Server-säkring: blockera linje-svar utan stöd --------
    const modelDomain = out?.meta?.domain === "line" ? "line" : out?.meta?.domain === "general" ? "general" : null;
    const isLine = (modelDomain === "line") || isLineTopic(message) || prevLooksLine(prev);

    const cards = out.cards || {};
    const heads = Array.isArray(cards.matched_headings) ? cards.matched_headings : [];
    const cov = Number(cards.coverage ?? 0);
    const steps = Array.isArray(cards.steps) ? cards.steps : [];

    // Om modellen vill förtydliga – låt gå igenom direkt (ingen gate)
    if (out?.need?.clarify) {
      return res.status(200).json({ reply: out });
    }

    if (isLine) {
      // LINE-läge: svar får bara ges om manualstöd finns (rubriker + rimlig coverage)
      const hasSupport = heads.length > 0 || cov >= 0.5 || steps.length >= 4;
      const thinSupport = heads.length === 0 && cov < 0.3;

      if (!hasSupport || thinSupport) {
        // Blockera operativa råd – be om mer info eller föreslå manual-uppdatering
        out.meta = { domain: "line" };
        out.spoken = out.spoken && heads.length>0
          ? `${out.spoken} Dubbelkolla mot manualens rubriker innan du gör något.` 
          : "Det här rör linjen, men jag hittar inte tydligt stöd i manualen för att guida säkert. Vill du att jag ställer en följdfråga så vi ringar in rätt avsnitt, eller att vi uppdaterar manualen?";
        out.need = out.need || {};
        if (!out.need.clarify && heads.length === 0) {
          out.need.clarify = true;
          out.need.question = out.need.question || "Kan du säga exakt vilken utrustning/avsnitt det gäller, så slår jag upp rätt del i manualen?";
        }
        out.cards = {
          summary: "Operativt svar blockerat: saknar tillräckligt manualstöd.",
          steps: [], explanation: "", pitfalls: [],
          simple: "Manualstöd saknas för säkra steg.",
          pro: "Otillräcklig manualreferens för operativa instruktioner.",
          follow_up: "Ska jag notera att manualen behöver uppdateras, eller vill du ge mer kontext?",
          coverage: cov || 0, matched_headings: heads
        };
        out.follow_up = out.cards.follow_up;
        return res.status(200).json({ reply: out });
      }

      // Delvis stöd: leverera men uppmana att verifiera
      if (cov < 0.6 || heads.length < 1) {
        out.meta = { domain: "line" };
        out.spoken = (out.spoken || "Okej.") + " Verifiera gärna mot rubrikerna jag visar i detaljer.";
        out.cards.follow_up = out.cards.follow_up || "Vill du att jag bryter ner nästa del?";
        return res.status(200).json({ reply: out });
      }

      // Bra stöd → kör
      out.meta = { domain: "line" };
      return res.status(200).json({ reply: out });
    }

    // GENERAL-läge → fri persona
    out.meta = { domain: "general" };
    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
