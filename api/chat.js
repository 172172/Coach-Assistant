// /api/chat.js
// Manual-först (RAG) för Linje 65. Operativa svar får ENDAST bygga på utdrag vi hämtar här.
// cards.steps ska vara rena åtgärdsmeningar UTAN numrering ("Steg 1", "1.", etc).

const KNOWLEDGE_URL = "https://raw.githubusercontent.com/172172/Coach-Assistant/main/assistant-knowledge.txt";
const CACHE_MS = 5 * 60 * 1000;

let knowledgeCache = { text: null, fetchedAt: 0 };
let ragCache = { sections: [], vectors: [], fetchedAt: 0 };

// ---------- Helpers ----------
const norm = (s="") => s.toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/ö/g,"o").replace(/ä/g,"a").replace(/å/g,"a")
  .replace(/\s+/g," ").trim();

function isSmalltalk(s="") {
  const t = norm(s);
  return /\b(hej+|h[aä]ll[aå]|tja+|god morgon|godkv[aä]ll|hur m[aå]r du|allt bra|l[aä]get|tack|vars[aå]god)\b/.test(t);
}
function looksOperational(s="") {
  const t = norm(s);
  return /linj|tapp|fyll|sortbyte|cip|skolj|flush|rengor|sanit|recept|batch|oee|hmi|plc|felsok|alarm|tryck|temperatur|flode|ventil|pump|kvalitet|prov|qc|haccp|ccp|s[aä]kerhet|underh[aå]ll|smorj|kalibr|setup|omst[aä]ll|stopporsak|setpoint|saetpunkt|etikett|kapsyl|burk|pack/.test(t);
}

async function fetchManual() {
  const now = Date.now();
  if (knowledgeCache.text && now - knowledgeCache.fetchedAt < CACHE_MS) return knowledgeCache.text;
  const res = await fetch(KNOWLEDGE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Misslyckades hämta kunskap: ${res.status}`);
  const text = await res.text();
  knowledgeCache = { text, fetchedAt: now };
  return text;
}

// Dela upp manualen till rubriksektioner + chunking ~1200 tecken
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

  const out = [];
  const MAX_CHUNK = 1200;
  for (const s of sections) {
    const base = `${s.heading}\n${s.text}`.trim();
    if (base.length <= MAX_CHUNK) { out.push({ heading: s.heading, chunk: base }); continue; }
    const parts = s.text.split(/\n\s*\n/);
    let buf = s.heading + "\n";
    for (const p of parts) {
      if ((buf + p).length > MAX_CHUNK) { out.push({ heading: s.heading, chunk: buf.trim() }); buf = s.heading + "\n" + p + "\n"; }
      else { buf += p + "\n\n"; }
    }
    if (buf.trim().length) out.push({ heading: s.heading, chunk: buf.trim() });
  }
  return out.filter(s => s.chunk && s.chunk.replace(/\W/g,"").length > 40);
}

// Embeddings
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
  if (ragCache.sections.length && now - ragCache.fetchedAt < CACHE_MS) return ragCache;
  const sections = splitIntoChunks(manual);
  const vectors = await embedAll(sections.map(s => s.chunk));
  ragCache = { sections, vectors, fetchedAt: now };
  return ragCache;
}

async function retrieve(query, prev) {
  const { sections, vectors } = await ensureIndex();
  const q = [query, prev?.question || "", prev?.assistant?.spoken || ""].filter(Boolean).join("\n");
  const qvec = (await embedAll([q]))[0];
  const scored = vectors.map((v,i)=>({ i, s: cosine(qvec, v) })).sort((a,b)=>b.s-a.s);

  const K = 8;
  const top = scored.slice(0, K).filter(o => o.s > 0.18);
  const picks = top.map(o => ({ ...sections[o.i], score: o.s }));
  const matched_headings = Array.from(new Set(picks.map(p => p.heading)));
  const avg = top.length ? top.reduce((a,b)=>a+b.s,0)/top.length : 0;
  const coverage = Math.max(0, Math.min(1, avg * 1.6));
  const context = picks.map((p,idx)=>`### [S${idx+1}] ${p.heading}\n${p.chunk}`).join("\n\n");
  return { context, matched_headings, coverage, any: picks.length>0 };
}

async function callOpenAI(system, user, { temperature=0.3, max_tokens=1600 } = {}) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature,
      max_tokens,
      messages: [{ role:"system", content: system }, { role:"user", content: user }],
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error("OpenAI chat error:", j); throw new Error("Chat API error"); }
  let out;
  try { out = JSON.parse(j.choices?.[0]?.message?.content || ""); }
  catch {
    out = {
      spoken: "Hoppsan — säg det gärna en gång till, jag lyssnar.",
      need: { clarify: true, question: "Kan du säga det på ett annat sätt?" },
      cards: { summary:"Behöver förtydligande.", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
      follow_up: ""
    };
  }
  return out;
}

// ---------- API ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null } = req.body || {};

    // Småprat = aldrig klarifiering
    if (isSmalltalk(message) && !looksOperational(message)) {
      const out = {
        spoken: "Jag mår prima — AI-pigg. Hur är läget hos dig?",
        need: { clarify: false },
        cards: { summary:"Småprat", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
        follow_up: ""
      };
      return res.status(200).json({ reply: out });
    }

    // Hämta relevanta stycken
    const { context, matched_headings, coverage, any } = await retrieve(message, prev);

    // Systemprompt: operativt = endast från KONTEKST; steps utan numrering
    const system = `
Du är röstmentor för Linje 65 (JARVIS + torr humor light). Svenska, varmt och tydligt.

KÄLLREGLER
- Du får KONTEKST (utdrag ur manualen). **Alla operativa råd måste bygga på KONTEKST.** Hitta inte på.
- Om KONTEKST är otillräcklig: ställ EN specifik följdfråga eller säg att manualen saknas. Inga gissningar.

STEGFORMAT
- "cards.steps" ska vara en lista av korta, konkreta åtgärder **utan** numrering eller prefix som "Steg 1:", "1.", "(1)". Vi numrerar i klienten.

TAL
- "spoken" ska låta som mänskligt tal, korta meningar, små bekräftelser. Säkerhet = seriöst tonläge.

RETUR (EXAKT JSON):
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
${any ? context : "(tomt — ingen träff i manualen)"}

Tidigare tur:
${prev ? JSON.stringify(prev) : "null"}

Fråga:
"${message}"

Instruktioner:
- Om frågan är operativ och KONTEKST är tom/otillräcklig: need.clarify=true och ställ EN konkret fråga som hjälper dig hitta rätt avsnitt.
- Om KONTEKST räcker: ge tydliga åtgärder i "cards.steps" (utan numrering), fyll "matched_headings" med rubriker från KONTEKST, och sätt "coverage" ungefär (${coverage.toFixed(2)}).
- Ingen text utanför JSON.
`.trim();

    let out = await callOpenAI(system, user, { temperature: 0.28, max_tokens: 1600 });

    // Efterkontroller
    const allowed = new Set(matched_headings);
    if (!out.cards) out.cards = { summary:"", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] };

    // Tillåt bara rubriker vi gav i KONTEKST
    out.cards.matched_headings = Array.isArray(out.cards.matched_headings)
      ? out.cards.matched_headings.filter(h => allowed.has(h))
      : [];

    // Om steg finns men inga rubriker – fyll med våra
    if (out.cards.steps?.length && out.cards.matched_headings.length === 0) {
      out.cards.matched_headings = matched_headings.slice(0, 4);
    }

    // Sätt coverage om saknas
    if (!(typeof out.cards.coverage === "number" && isFinite(out.cards.coverage))) {
      out.cards.coverage = coverage;
    }

    // Sista säkring: operativ fråga men KONTEKST tom → be om precisering
    if (looksOperational(message) && !any && (out.cards.steps?.length || /steg|öppna|st[aä]ng|tryck|ventil|temperatur/i.test(out.spoken||""))) {
      out = {
        spoken: "Det där låter operativt, men jag hittar ingen träff i manualen ännu. Säg vilket moment eller rubrik det gäller så letar jag rätt.",
        need: { clarify: true, question: "Vilken rubrik/utrustning avser du? (t.ex. 'Tapp – sortbyte', 'Tapp – gul lampa', 'CIP – tapp')" },
        cards: { summary:"Operativ fråga utan träff i KONTEKST.", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
        follow_up: ""
      };
    }

    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
