// /api/chat.js
// Fri, konversationell AI med manual-stöd för operativa svar.
// Fix: småprat ger aldrig "klarifiera", och operativa råd kräver manualstöd – annars fråga öppet.

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

// --- Heuristik (tunn, ej låsande) ---
const norm = (s="") => s.toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/ö/g,"o").replace(/ä/g,"a").replace(/å/g,"a")
  .replace(/\s+/g," ").trim();

function looksOperationalQuestion(s="") {
  const t = norm(s);
  return /linj|tapp|fyll|sortbyte|cip|skolj|flush|rengor|sanit|recept|batch|oee|hmi|plc|felsok|alarm|tryck|temperatur|flode|ventil|pump|kvalitet|prov|qc|haccp|ccp|sakerhet|underhall|smorj|kalibr|setup|omst|omstall|stopporsak|setpoint|saetpunkt|etikett|kapsyl|burk|pack|pepsi|cola|lager|ipa|sirap|syrup/.test(t);
}
function isSmalltalk(s="") {
  const t = norm(s);
  return /\b(hej+|hall[aå]|tja+|tj[aä]|god morgon|godkv[aä]ll|hur mar du|hur e det|laget|allt bra|m[aå]r bra|tack|tack s[aå] mycket|vars[aå]god|vad g[öo]r du)\b/.test(t);
}
function looksOperationalAnswer(cards={}, spoken="") {
  const steps = Array.isArray(cards.steps) ? cards.steps : [];
  const joined = `${spoken} ${steps.join(" ")}`.toLowerCase();
  return steps.length > 0 || /\bsteg\b|ventil|stang|öppna|oppna|tryck|temperatur|flode|spola|cip|flush|s[aä]kerhet|larm|hmi|plc/.test(joined);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null } = req.body || {};
    const knowledge = await getKnowledge();

    // --- Systemprompt: fri stil + manualkrav för operativt + småprat = inga klarifieringar ---
    const system = `
Du är en AI-assistent skapad av Kevin – Douglas Adams möter JARVIS.
Svara alltid på svenska. Var vänlig, kvick där det passar, men tydlig och ärlig.

STIL
- Vänlig, informell, konversationell. Subtil humor OK (inte när det gäller säkerhet).
- Anpassa djup/ton efter frågan. Håll det kort men innehållsrikt.

SANNING OCH KÄLLOR
- Allmänna frågor: svara fritt.
- Operativt (drift/linje/procedurer/kvalitet/säkerhet/parametrar/felsökning): bygg svaret på "Kunskap" (manualen) nedan.
  * Ge tydliga, NUMRERADE steg när det behövs.
  * Lista rubrikerna du faktiskt använder i "matched_headings".
  * Hitta inte på siffror/parametrar. Om manualen saknar värden: säg det och håll det generellt (“enligt manualens gränsvärden”).
  * Om underlaget är för vagt: ställ EN öppen följdfråga.
  * Om manualen inte täcker det: säg det rakt ut och föreslå uppdatering (ge inte operativa steg).

SMÅPRAT
- För hälsningar, “hur mår du”, “tack”, etc.: svara kort och trevligt. Sätt need.clarify=false.

RETURFORMAT (EXAKT JSON, ingen text utanför):
{
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

COVERAGE (kalibrering):
- ~0.75+: flera rubriker direkt relevanta; steg kommer därifrån.
- ~0.6–0.75: delvis stöd; komplettera med säkra generella formuleringar.
- ~0.4–0.6: viss relevans; leverera steg och be att verifiera mot rubrikerna.
- <0.3: sannolikt otillräckligt → be om precisering eller säg att manualen saknas/behöver uppdateras.
`.trim();

    // --- Userprompt ---
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
- Svara fritt på allmänna frågor.
- Om du ger operativa råd: luta dig på manualen, lista matched_headings och sätt coverage realistiskt.
- Om du saknar underlag: be om EN precisering eller säg att manualen saknas/behöver uppdateras (undvik operativa steg).
- För småprat/hälsningar/tack: ge kort, trevligt svar – need.clarify=false.
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
        temperature: 0.3,
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

    // --- Tolka svaret ---
    let content = data.choices?.[0]?.message?.content || "";
    let out;
    try {
      out = JSON.parse(content);
    } catch {
      out = {
        spoken: "Oj, det där blev otydligt – kan du säga det på ett annat sätt?",
        need: { clarify: true, question: "Kan du precisera vad du behöver?" },
        cards: {
          summary: "Behöver förtydligande.",
          steps: [], explanation: "", pitfalls: [],
          simple: "", pro: "", follow_up: "",
          coverage: 0, matched_headings: []
        },
        follow_up: ""
      };
    }

    // --- Småprat-fix: modell får aldrig be om klarifiering på hälsningar ---
    if (isSmalltalk(message)) {
      out.need = { clarify: false };
      if (!out.spoken || /precisera|oklart|mer info/i.test(out.spoken)) {
        out.spoken = "Jag mår fint – AI-varianten av pigg på kaffe! Hur kan jag hjälpa dig idag?";
      }
      out.cards = out.cards || {};
      out.cards.summary = out.cards.summary || "Småprat";
      out.cards.coverage = Number(out.cards.coverage ?? 0);
      return res.status(200).json({ reply: out });
    }

    // --- Tunn server-säkring för operativt utan manualstöd ---
    const isOperativeQ = looksOperationalQuestion(message) || looksOperationalQuestion(prev?.question || "");
    const hasOperativeTone = looksOperationalAnswer(out.cards, out.spoken);
    const heads = Array.isArray(out?.cards?.matched_headings) ? out.cards.matched_headings : [];
    const cov = Number(out?.cards?.coverage ?? 0);
    const steps = Array.isArray(out?.cards?.steps) ? out.cards.steps : [];

    if ((isOperativeQ || hasOperativeTone) && heads.length === 0 && cov < 0.5) {
      out.spoken = "Det låter som en linje-/procedurfråga. För att guida säkert behöver jag veta exakt utrustning/avsnitt, så jag kan peka på rätt del i manualen. Vad gäller det?";
      out.need = { clarify: true, question: "Vilken utrustning/avsnitt gäller det? (t.ex. Tapp – sortbyte, CIP – tapp, Kvalitetsprov: produkt X)" };
      out.cards = {
        summary: "Operativ fråga utan tydligt manualstöd – ber om precisering.",
        steps: [], explanation: "", pitfalls: [],
        simple: "Säg exakt vilket avsnitt/utrustning så guidar jag rätt.",
        pro: "Kräver rubrikvalidering innan operativa steg lämnas.",
        follow_up: "Vill du att jag föreslår närmaste avsnitt ur manualen?",
        coverage: cov || 0, matched_headings: []
      };
      out.follow_up = out.cards.follow_up;
      return res.status(200).json({ reply: out });
    }

    // Delvis stöd → leverera, men påminn om verifiering
    if ((isOperativeQ || hasOperativeTone) && (cov < 0.6 || heads.length < 1) && steps.length > 0) {
      out.spoken = (out.spoken || "Okej.") + " Verifiera gärna mot manualens rubriker i detaljerna.";
      out.cards.follow_up = out.cards.follow_up || "Vill du att jag delar upp nästa del?";
      return res.status(200).json({ reply: out });
    }

    // Annars – skicka igenom som det är
    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
