// /api/chat.js
// Manual-först Linje 65 med model-driven tolkning (ingen hårdkodad domänlogik).
// Flöde: 1) Hämta rubriker ur manualen. 2) Låt modellen tolka frågan (intent/slots) mot rubrikerna.
//        3) Semantisk retrieval av relevanta textstycken. 4) Svara ENDAST utifrån dessa för operativt.

const KNOWLEDGE_URL = "https://raw.githubusercontent.com/172172/Coach-Assistant/main/assistant-knowledge.txt";
const CACHE_MS = 5 * 60 * 1000;

let knowledgeCache = { text: null, fetchedAt: 0 };
let ragCache = { sections: [], vectors: [], fetchedAt: 0 };
let headingsCache = { list: [], fetchedAt: 0 };

// --------------------------- helpers ---------------------------
const norm = (s="") => String(s).toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[åä]/g,"a").replace(/[ö]/g,"o")
  .replace(/\s+/g," ").trim();

function isSmalltalk(s="") {
  const t = norm(s);
  return /\b(hej+|h[aä]ll[aå]|tja+|god morgon|godkv[aä]ll|hur m[aå]r du|allt bra|l[aä]get|tack|vars[aå]god|vad g[^ ]*r du)\b/.test(t);
}
function looksOperational(s="") {
  const t = norm(s);
  // bred indikator, men inte hårdkodade slots – bara detektera "låter som linjefråga"
  return /\b(linje|tapp|fyll|sortbyte|cip|rengor|sanit|flush|recept|batch|oee|hmi|plc|fels[oö]k|alarm|tryck|temperatur|fl[oö]de|ventil|pump|kvalitet|prov|qc|haccp|ccp|s[aä]kerhet|underh[aå]ll|kalibr|omst[aä]ll|stopporsak|setpoint|etikett|kapsyl|burk|pack)\b/.test(t);
}

// --------------------------- manual fetch/split ---------------------------
async function fetchManual() {
  const now = Date.now();
  if (knowledgeCache.text && now - knowledgeCache.fetchedAt < CACHE_MS) return knowledgeCache.text;
  const res = await fetch(KNOWLEDGE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Misslyckades hämta kunskap: ${res.status}`);
  const text = await res.text();
  knowledgeCache = { text, fetchedAt: now };
  return text;
}

function extractHeadings(text) {
  const lines = text.split(/\r?\n/);
  const heads = [];
  for (const line of lines) {
    const m = line.match(/^(#{2,4})\s*(.+?)\s*$/);
    if (m) heads.push(m[2].trim());
  }
  return heads.filter(h => h.length >= 3);
}

function splitIntoChunks(manual) {
  const lines = manual.split(/\r?\n/);
  const sections = [];
  let current = { heading: "Förord", content: [] };
  for (const line of lines) {
    const m = line.match(/^(#{2,4})\s*(.+?)\s*$/);
    if (m) {
      if (current.content.length) sections.push({ heading: current.heading, text: current.content.join("\n").trim() });
      current = { heading: m[2].trim(), content: [] };
    } else {
      current.content.push(line);
    }
  }
  if (current.content.length) sections.push({ heading: current.heading, text: current.content.join("\n").trim() });

  // chunk ~1200 tecken per bit
  const out = [];
  const MAX = 1200;
  for (const s of sections) {
    const base = `${s.heading}\n${s.text}`.trim();
    if (base.length <= MAX) { out.push({ heading: s.heading, chunk: base }); continue; }
    const paras = s.text.split(/\n\s*\n/);
    let buf = s.heading + "\n";
    for (const p of paras) {
      if ((buf + p).length > MAX) { out.push({ heading: s.heading, chunk: buf.trim() }); buf = s.heading + "\n" + p + "\n"; }
      else { buf += p + "\n\n"; }
    }
    if (buf.trim().length) out.push({ heading: s.heading, chunk: buf.trim() });
  }
  return out.filter(s => s.chunk && s.chunk.replace(/\W/g,"").length > 40);
}

// --------------------------- embeddings / retrieval ---------------------------
async function embedAll(texts) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts })
  });
  const j = await r.json();
  if (!r.ok) { console.error("Embeddings error:", j); throw new Error("Embeddings API error"); }
  return j.data.map(d => d.embedding);
}
function cosine(a, b) {
  let dot=0, na=0, nb=0;
  for (let i=0;i<a.length;i++){ const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-8);
}
async function ensureIndex() {
  const manual = await fetchManual();
  const now = Date.now();
  if (ragCache.sections.length && now - ragCache.fetchedAt < CACHE_MS) {
    if (!headingsCache.list.length || now - headingsCache.fetchedAt >= CACHE_MS) {
      headingsCache = { list: extractHeadings(manual), fetchedAt: now };
    }
    return ragCache;
  }
  const sections = splitIntoChunks(manual);
  const vectors = await embedAll(sections.map(s => s.chunk));
  ragCache = { sections, vectors, fetchedAt: now };
  headingsCache = { list: extractHeadings(manual), fetchedAt: now };
  return ragCache;
}

async function retrieve(queryStrings /* string[] */) {
  await ensureIndex();
  const { sections, vectors } = ragCache;
  const inputs = (queryStrings || []).filter(Boolean);
  if (!inputs.length) return { context:"", matched_headings:[], coverage:0, any:false };

  const qvecs = await embedAll(inputs);
  // Skår varje chunk mot medel av frågevektorer
  const qavg = new Array(qvecs[0].length).fill(0);
  qvecs.forEach(v => { for (let i=0;i<v.length;i++) qavg[i]+=v[i]; });
  for (let i=0;i<qavg.length;i++) qavg[i] /= qvecs.length;

  const scored = vectors.map((v,i)=>({ i, s: cosine(qavg, v) })).sort((a,b)=>b.s-a.s);
  const K = 8;
  const top = scored.slice(0, K).filter(o => o.s > 0.18);
  const picks = top.map(o => ({ ...sections[o.i], score: o.s }));
  const matched_headings = Array.from(new Set(picks.map(p => p.heading)));
  const avg = top.length ? top.reduce((a,b)=>a+b.s,0)/top.length : 0;
  const coverage = Math.max(0, Math.min(1, avg * 1.6));
  const context = picks.map((p,idx)=>`### [S${idx+1}] ${p.heading}\n${p.chunk}`).join("\n\n");
  return { context, matched_headings, coverage, any: picks.length>0 };
}

// --------------------------- model-driven parsing (no hardcoded domain) ---------------------------
async function modelParseIntent(message, prevIntent) {
  await ensureIndex();
  const heads = headingsCache.list.slice(0, 300); // ge bara rubrikerna, inte hela manualen

  const system = `
Du är en parser. Läs användarens yttrande och sammanfatta vad de försöker göra
relaterat till Linje 65. Du får en lista med rubriker från manualen som "ontologi".
Använd dem som vägledning när du namnger intent/område, men gissa inte.

RETURERA ENDAST JSON:
{
  "operational": boolean,              // handlar det om drift/procedur/säkerhet?
  "intent": string|null,               // t.ex. "sortbyte", "CIP", "gul lampa", eller rubriksnära term
  "area": string|null,                 // t.ex. "Tapp", "CIP – tapp" eller null
  "entities": {                        // valfritt: nyckel:värde (t.ex. from, to, produkt, larm_id)
    "from"?: string, "to"?: string, "produkt"?: string, "larm_id"?: string
  },
  "queries": string[],                 // 2–5 korta semantiska sökfraser att använda vid retrieval
  "confidence": number,                // 0..1
  "ask": string|null                   // om confidence < 0.6: EN specifik följdfråga
}
`.trim();

  const user = `
Rubriker från manualen (urval):
- ${heads.join("\n- ")}

Tidigare intent (kan vara null):
${prevIntent ? JSON.stringify(prevIntent) : "null"}

Användarens text:
"${message}"

Instruktion:
- Om det låter operativt, sätt "operational": true och föreslå "intent" och "area" som ligger nära rubrikerna.
- Extrahera tydliga entiteter om möjligt (ex. "läsk till läsk" → from="läsk", to="läsk").
- Fyll "queries" med olika nyckelord/fraser att söka efter (inkludera ev. rubrikfraser).
- Om du är osäker (confidence < 0.6), skriv en kort fråga i "ask" som hjälper att välja rätt rubrik. Bara EN fråga.
- Ingen text utanför JSON.
`.trim();

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model:"gpt-4o", temperature:0.2, max_tokens:300, messages:[
      { role:"system", content: system },
      { role:"user", content: user }
    ]})
  });
  const j = await r.json();
  if (!r.ok) { console.error("parse error:", j); return { operational:false, intent:null, area:null, entities:{}, queries:[], confidence:0, ask:null }; }
  try {
    const parsed = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    // sanity
    parsed.entities = parsed.entities || {};
    parsed.queries = Array.isArray(parsed.queries) ? parsed.queries.filter(Boolean).slice(0,5) : [];
    return parsed;
  } catch {
    return { operational:false, intent:null, area:null, entities:{}, queries:[], confidence:0, ask:null };
  }
}

// --------------------------- answer model ---------------------------
async function callModelAnswer({ context, matched_headings, coverage, message, parsed, prev }) {
  const system = `
Du är röstmentor för Linje 65 (tänk JARVIS + diskret humor). Svenska, tydlig och trygg.

KÄLLREGLER
- Du får KONTEKST från manualen. **Alla operativa råd måste bygga på KONTEKST.**
- Om KONTEKST inte räcker: be om EN precisering kopplad till rubriker/moment. Hitta inte på.

FORMAT
- "cards.steps" är åtgärdsrader **utan numrering/prefix**. (Klienten numrerar.)
- "spoken" = kort, mänsklig leverans. Vid säkerhet: seriöst tonläge.

RETURERA EXAKT JSON:
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

  const user = `
KONTEKST (använd endast detta för operativa svar):
${context || "(tomt)"}

Tolkning (kan vara delvis):
${JSON.stringify(parsed || {}, null, 2)}

Tidigare tur:
${prev ? JSON.stringify(prev) : "null"}

Fråga:
"${message}"

Instruktioner:
- Om "parsed.operational" är true men KONTEKST är tom/otillräcklig: need.clarify=true och fråga EN sak som hjälper att hitta rätt rubrik.
- Om KONTEKST räcker: ge kort "spoken", tydliga "cards.steps" (utan numrering) och fyll "matched_headings" med rubriker från KONTEKST. Sätt coverage ungefär (${coverage.toFixed(2)}).
- Ingen text utanför JSON.
`.trim();

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model:"gpt-4o", temperature:0.28, max_tokens:1700, messages:[
      { role:"system", content: system },
      { role:"user", content: user }
    ] })
  });
  const j = await r.json();
  if (!r.ok) { console.error("answer error:", j); throw new Error("Chat API error"); }
  try {
    const out = JSON.parse(j.choices?.[0]?.message?.content || "");
    // säkra fält
    out.cards = out.cards || { summary:"", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:coverage, matched_headings:[] };
    // rubriker: håll dig till de vi gav
    const allowed = new Set(matched_headings || []);
    out.cards.matched_headings = Array.isArray(out.cards.matched_headings)
      ? out.cards.matched_headings.filter(h => allowed.has(h))
      : [];
    if (out.cards.steps?.length && out.cards.matched_headings.length === 0) {
      out.cards.matched_headings = (matched_headings || []).slice(0,4);
    }
    if (typeof out.cards.coverage !== "number") out.cards.coverage = coverage;
    return out;
  } catch {
    return {
      spoken: "Hoppsan — säg det gärna en gång till, jag lyssnar.",
      need: { clarify: true, question: "Kan du förtydliga vilket moment eller rubrik det gäller?" },
      cards: { summary:"Behöver förtydligande.", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage, matched_headings:[] },
      follow_up: ""
    };
  }
}

// --------------------------- handler ---------------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null } = req.body || {};

    // Småprat → svara fritt, ingen klarifiering
    if (isSmalltalk(message) && !looksOperational(message)) {
      const out = {
        spoken: "Jag mår fint — AI-pigg. Hur är läget hos dig?",
        need: { clarify: false },
        cards: { summary:"Småprat", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
        follow_up: ""
      };
      return res.status(200).json({ reply: out });
    }

    // 1) Låt modellen TOLKA vad du menar (ingen hårdkodad lista)
    const parsed = await modelParseIntent(message, prev?.assistant?.parsed || null);

    // 2) Bygg sökfrågor för retrieval (frågan, tolkning, ev. area/intent)
    const q = [message];
    if (parsed?.area) q.push(parsed.area);
    if (parsed?.intent) q.push(parsed.intent);
    if (Array.isArray(parsed?.queries)) q.push(...parsed.queries);
    if (parsed?.entities) {
      Object.values(parsed.entities).forEach(v => { if (v) q.push(String(v)); });
    }

    const { context, matched_headings, coverage, any } = await retrieve(q);

    // 3) Om operativt & låg confidence eller tom kontext → be om EN precisering
    if (parsed?.operational && (!any || coverage < 0.35)) {
      const ask = parsed?.ask || "Vilken rubrik/utrustning gäller det exakt?";
      const out = {
        spoken: "Det här låter operativt. För att vara exakt behöver jag en grej till.",
        need: { clarify: true, question: ask },
        cards: { summary:"Behöver precisering för att hitta rätt avsnitt.", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
        follow_up: "",
        parsed
      };
      return res.status(200).json({ reply: out });
    }

    // 4) Generera svaret (manual-först)
    let out = await callModelAnswer({ context, matched_headings, coverage, message, parsed, prev });

    // 5) Sista säkring: om operativt men ingen kontext, stoppa gissningar
    if (parsed?.operational && !any) {
      out = {
        spoken: "Jag hittar inget i manualen på det där än. Säg rubriken eller momentet så guidar jag rätt.",
        need: { clarify: true, question: "Exakt vilket avsnitt i manualen? (t.ex. 'Tapp – sortbyte')" },
        cards: { summary:"Operativ fråga utan träff i kontext.", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
        follow_up: "",
        parsed
      };
    } else {
      // bifoga parsed så klienten kan minnas slots i prev.assistant
      out.parsed = parsed;
    }

    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
