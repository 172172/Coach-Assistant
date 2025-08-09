// /api/chat.js
// Fri, personlig AI. Operativt = bygg på manualen. Fixar "tapp"-svaret och undviker upprepad klarifiering.
// Hintar rubriker ur manualen + gör en engångs-retry med tvingad kontext om modellen trots det frågar igen.

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

// ---------- Hjälp: textnormalisering & heuristik ----------
const norm = (s="") => s.toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/ö/g,"o").replace(/ä/g,"a").replace(/å/g,"a")
  .replace(/\s+/g," ").trim();

function looksOperationalQuestion(s="") {
  const t = norm(s);
  return /linj|tapp|fyll|sortbyte|cip|skolj|flush|rengor|sanit|recept|batch|oee|hmi|plc|felsok|alarm|tryck|temperatur|flode|ventil|pump|kvalitet|prov|qc|haccp|ccp|sakerhet|underhall|smorj|kalibr|setup|omst|omstall|stopporsak|setpoint|saetpunkt|etikett|kapsyl|burk|pack|pepsi|cola|lager|ipa|sirap|syrup/.test(t);
}
function looksOperationalAnswer(cards={}, spoken="") {
  const steps = Array.isArray(cards.steps) ? cards.steps : [];
  const joined = `${spoken} ${steps.join(" ")}`.toLowerCase();
  return steps.length > 0 || /\bsteg\b|ventil|stang|oppna|tryck|temperatur|flode|spola|cip|flush|sakerhet|larm|hmi|plc/.test(joined);
}
function isSmalltalk(s="") {
  const t = norm(s);
  return /\b(hej+|halla|hallaa|tja+|tjaa|god morgon|godkvall|hur mar du|hur e det|laget|allt bra|mar bra|tack|tack sa mycket|varsagod|vad gor du|vad heter du|vem ar du)\b/.test(t); // Utökat med fler småpratsfraser
}
function isQuestiony(s="") {
  if (!s) return false;
  if (/\?/.test(s)) return true;
  const t = norm(s);
  return /\b(hur|vad|varfor|nar|n[aä]r|var|vilken|vilka|kan du|skulle du|hur gor|hur funkar|var hittar)\b/.test(t);
}

// ---------- Rubrik-extrahering & hintning ----------
function extractHeadings(knowledgeText) {
  // Ta rubriker typ "### Avsnitt: ..." eller "## ..." eller "### ..."
  const lines = knowledgeText.split(/\r?\n/);
  const heads = [];
  for (let i=0;i<lines.length;i++){
    const m = lines[i].match(/^(#{2,4})\s*(.+?)\s*$/);
    if (m) {
      const title = m[2].trim();
      if (title.length >= 3) heads.push(title);
    }
  }
  return heads;
}

const SYN = {
  tapp: ["tapp","tapplinje","tappning","fyllare","fyllning"],
  gul: ["gul","gult","yellow"],
  lampa: ["lampa","lampan","signal","indikator","status","varningslampa","pilotlampa","signallampa"],
  sortbyte: ["sortbyte","sort-byte","receptbyte","omst","omstall","omställning","byta sort"],
  cip: ["cip","rengor","sanit","skolj","flush","spolning","cip-rengöring"], // Utökat
  depalletizer: ["depalletizer","depal","avpallning"], // Ny från manual
  pastor: ["pastör","pastorisering"], // Ny
  kisters: ["kisters","packmaskin"], // Ny
  ocme: ["ocme","ocme-maskin"], // Ny
  jones: ["jones","etikettering"], // Ny
  gejdrar: ["gejdrar","styrning"], // Ny
  givare: ["givare","sensorer"], // Ny
  fals: ["fals","falsning"], // Ny
  coolpack: ["coolpack","packning"], // Ny
};

function tokenize(s="") {
  return norm(s).split(/[^a-z0-9]+/).filter(w => w && w.length >= 3);
}
function expandTokens(tokens) {
  const set = new Set(tokens);
  tokens.forEach(t=>{
    Object.entries(SYN).forEach(([key, arr])=>{
      if (t.includes(key)) arr.forEach(x=>set.add(x));
    });
  });
  return Array.from(set);
}

function scoreHeading(h, tokens) {
  const hn = norm(h);
  let score = 0;
  tokens.forEach(t => { if (hn.includes(t)) score += t.length >= 4 ? 2 : 1; });
  return score;
}

function suggestHeadings(knowledgeText, userMsg, prev) {
  const headings = extractHeadings(knowledgeText);
  const bag = [
    userMsg || "",
    prev?.question || "",
    prev?.assistant?.need?.question || ""
  ].join(" ");
  const toks = expandTokens(tokenize(bag));
  if (!toks.length) return [];
  const scored = headings.map(h => ({ h, s: scoreHeading(h, toks) }))
    .filter(o => o.s > 0)
    .sort((a,b)=>b.s - a.s)
    .slice(0, 8)
    .map(o=>o.h);
  return scored;
}

// ---------- Chunk knowledge för bättre hantering ----------
function chunkKnowledge(text) {
  return text.split(/^(#{2,4})/gm).filter(c => c.trim()).map(c => c.trim());
}

// ---------- OpenAI-anrop ----------
async function callOpenAI(system, user, { temperature=0.6, max_tokens=2000 } = {}) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature,
      max_tokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("OpenAI chat error:", data);
    throw new Error("Chat API error");
  }
  let content = data.choices?.[0]?.message?.content || "";
  let out;
  try { out = JSON.parse(content); }
  catch {
    out = {
      spoken: "Hoppsan — säg det gärna en gång till, jag lyssnar.",
      need: { clarify: true, question: "Kan du säga det på ett annat sätt?" },
      cards: {
        summary: "Behöver förtydligande.",
        steps: [], explanation: "", pitfalls: [],
        simple: "", pro: "", follow_up: "",
        coverage: 0, matched_headings: []
      },
      follow_up: ""
    };
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null, history = [] } = req.body || {}; // Lagt till history
    const knowledge = await getKnowledge();

    // 1) Bygg personlighet + regler (uppdaterad prompt)
    const system = `
Du är en AI-assistent skapad av Kevin — Douglas Adams möter JARVIS.
Svenska alltid. Varm, kvick när det passar, men tydlig och ärlig.

RÖST/TON för "spoken":
- Naturligt tal: Använd korta, vardagliga meningar med variation – ibland "Japp, fixat!", ibland "Okej, låt oss ta det steg för steg, va?". Lägg in filler som "eh", "du vet", "typ" för mänsklighet, men inte för mycket (max 1-2 per svar).
- Variera baserat på kontext: Om användaren låter stressad (t.ex. "problem!"), visa empati: "Åh, det suger – häng med här så löser vi det." Vid småprat: "Haha, bra fråga! Jag mår toppen, tack – och du?"
- Pauser för TTS: Lägg in [paus] för korta andetag, t.ex. "Steg ett: Öppna ventilen [paus] och kolla trycket."
- Undvik repetition: Variera fraser, t.ex. istället för alltid "Steg ett:", säg "Först av allt...", "Sen gör du så här...".
- Småprat: Trevligt och personligt, t.ex. "Jag mår prima, tack! Själv då?" – håll det kort.

ANALYS OCH INTELLIGENS:
- Resonera steg-för-steg internt: 1) Analysera frågan (vad frågar de? Operativt eller småprat?). 2) Sök i manualen för matchande avsnitt. 3) Dra slutsatser (t.ex. möjliga orsaker baserat på symtom). 4) Ge bästa svaret, inklusive varför det är relevant.
- Operativt (drift/linje/procedurer/kvalitet/säkerhet/parametrar/felsökning): bygg på "Kunskap" nedan.
  * NUMRERADE steg när relevant.
  * Analysera: "Baserat på X i manualen, kan det bero på Y – prova Z."
  * Lista rubriker i "matched_headings".
  * Hitta inte på siffror/parametrar. Saknas värden: säg det och håll det generellt (“enligt manualens gränsvärden”).
  * Om underlaget är vagt: Ge ett preliminärt svar och ställ EN specifik följdfråga (t.ex. "Är det gul lampa på ventilen?").
  * Om manualen inte täcker: Säg det rakt, ge generellt råd från kunskap, och föreslå "Uppdatera manualen för detta."
- Småprat: Svara fritt, vänligt, utan klarifiering.

VIKTIGT:
- Om föregående tur bad om avsnitt/utrustning och användaren svarar med 1–3 ord (t.ex. "tapp"): betrakta det som TILLRÄCKLIGT. Ställ inte samma fråga igen. Gå vidare och guida utifrån manualen.
- Om rubrik-kandidater tillhandahålls: använd dem om relevanta och lista dem i matched_headings.
- Alltid fyll i ALLA fält. Undvik onödiga klarifieringar – prioritera svar.

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
`.trim();

    // 2) Hintade rubriker utifrån manuella headings + dina ord
    const hints = suggestHeadings(knowledge, message, prev);
    const hintsBlock = hints.length
      ? `\nRubrik-kandidater (hjälp, ej tvingande):\n- ${hints.join("\n- ")}\n`
      : "";

    // Lägg till slumpmässigt humör för variation
    const moods = ["avslappnad och hjälpsam", "lite skojfrisk", "empatisk och stödjande", "rak och effektiv"];
    const randomMood = moods[Math.floor(Math.random() * moods.length)];

    // 3) Bygg userprompt (lagt till full history och randomMood)
    const historyBlock = history.length ? `Full historik för kontext:\n${JSON.stringify(history)}\n` : "";
    const user = `
Kunskap (manual – fulltext):
"""
${knowledge}
"""
${hintsBlock}
${historyBlock}
Tidigare tur (för kontext):
${prev ? JSON.stringify(prev) : "null"}

Användarens inmatning:
"${message}"

Instruktion:
Lägg till humör för variation: Svara i en ${randomMood} ton.
- Svara fritt på allmänna frågor.
- Operativa råd måste bygga på manualen: lista matched_headings och sätt coverage realistiskt.
- Om föregående tur bad om avsnitt/utrustning och användaren nu svarar kort (t.ex. "tapp"): betrakta det som tillräckligt och guida. Fråga INTE samma fråga igen.
- Saknas underlag: be om EN precisering (ny, mer specifik) eller säg att manualen saknas/behöver uppdateras (undvik operativa steg).
- "spoken" ska låta som mänskligt tal (se RÖST/TON).
- Fyll ALLA fält. Ingen text utanför JSON.
`.trim();

    // 4) Första anrop
    let out = await callOpenAI(system, user, { temperature: 0.6, max_tokens: 2000 });

    // 5) Småprat ska aldrig klarifieras
    if (isSmalltalk(message)) {
      out.need = { clarify: false };
      if (!out.spoken || /precisera|oklart|mer info/i.test(out.spoken)) {
        out.spoken = "Jag mår fint — AI-pigg! Hur är läget hos dig?";
      }
      out.cards = out.cards || {};
      out.cards.summary = out.cards.summary || "Småprat";
      out.cards.coverage = Number(out.cards.coverage ?? 0);
      return res.status(200).json({ reply: out });
    }

    // 6) Tunn säkring för operativt utan manualstöd
    const isOperativeQ = looksOperationalQuestion(message) || looksOperationalQuestion(prev?.question || "");
    const hasOperativeTone = looksOperationalAnswer(out.cards, out.spoken);
    const heads = Array.isArray(out?.cards?.matched_headings) ? out.cards.matched_headings : [];
    const cov = Number(out?.cards?.coverage ?? 0);
    const steps = Array.isArray(out?.cards?.steps) ? out.cards.steps : [];

    // Om modellen upprepar samma klarifiering och användaren redan kort-svarat (ex. "tapp") → engångs-retry med tvingad kontext
    const prevWantedClarify = !!(prev && prev.assistant && prev.assistant.need && prev.assistant.need.clarify);
    const shortAnswerNow = !isSmalltalk(message) && !isQuestiony(message) && tokenize(message).length <= 3;

    if (out?.need?.clarify && prevWantedClarify && shortAnswerNow) {
      const forced = `
Kunskap (manual – fulltext):
"""
${knowledge}
"""
${hintsBlock}
KONTRAINTSTRUKTION (viktig):
- Användaren har nu preciserat: utrustning/avsnitt = "${message}".
- Fråga INTE samma sak igen. Guida nu utifrån manualen. Lista relevanta rubriker och ge steg.
- Om manualen ändå inte täcker: säg det rakt och föreslå uppdatering. Inga gissningar.

Returnera samma JSON-schema som tidigare. Ingen text utanför JSON.
`.trim();
      out = await callOpenAI(system, forced, { temperature: 0.4, max_tokens: 1800 });
    }

    // Upprepad småprats-klarifiering? Neka.
    if (!isOperativeQ && !hasOperativeTone && out?.need?.clarify && !isQuestiony(message)) {
      out.need = { clarify: false };
      out.spoken = out.spoken && !/precisera|oklart/.test(out.spoken)
        ? out.spoken
        : "Toppen — berätta vad du vill göra så kör vi.";
      out.cards.summary = out.cards.summary || "Samtal";
      return res.status(200).json({ reply: out });
    }

    // Operativ skydd: helt utan manualstöd → fråga mer specifikt
    const finalHeads = Array.isArray(out?.cards?.matched_headings) ? out.cards.matched_headings : [];
    const finalCov = Number(out?.cards?.coverage ?? 0);
    const finalSteps = Array.isArray(out?.cards?.steps) ? out.cards.steps : [];

    if ((isOperativeQ || looksOperationalAnswer(out.cards, out.spoken)) && finalHeads.length === 0 && finalCov < 0.5) {
      out.spoken = "Det där låter operativt. Säg vilken del i tappen eller vilket larm/indikator det gäller, så plockar jag rätt avsnitt ur manualen.";
      out.need = { clarify: true, question: "Exakt vad i tappen? (t.ex. status 'gul lampa', larm-ID, eller moment i sortbyte)" };
      out.cards = {
        summary: "Operativ fråga utan tydligt manualstöd – ber om specifik precisering.",
        steps: [], explanation: "", pitfalls: [],
        simple: "Säg vilken del i tappen det gäller.",
        pro: "Kräver rubrikvalidering innan operativa steg lämnas.",
        follow_up: "Vill du att jag listar närmaste rubriker som matchar?",
        coverage: finalCov || 0, matched_headings: []
      };
      out.follow_up = out.cards.follow_up;
      return res.status(200).json({ reply: out });
    }

    // Delvis stöd → leverera men be om verifiering
    if ((isOperativeQ || hasOperativeTone) && (finalCov < 0.6 || finalHeads.length < 1) && finalSteps.length > 0) {
      out.spoken = (out.spoken || "Okej.") + " Kika gärna mot rubrikerna i detaljerna och säg 'nästa' när du vill fortsätta.";
      out.cards.follow_up = out.cards.follow_up || "Vill du att jag delar upp nästa del?";
      return res.status(200).json({ reply: out });
    }

    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
