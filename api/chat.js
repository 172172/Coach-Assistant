// /api/chat.js
// Linje 65 mentor: RAG + robust intent/slot-filling för "sortbyte" m.m.
// Operativt svar får ENDAST bygga på RAG-kontekst. Ingen påhittad info.
// Hanterar "läsktillläsk", "sorbyteläsk", kortsvar som "läsk", osv.

const KNOWLEDGE_URL = "https://raw.githubusercontent.com/172172/Coach-Assistant/main/assistant-knowledge.txt";
const CACHE_MS = 5 * 60 * 1000;

let knowledgeCache = { text: null, fetchedAt: 0 };
let ragCache = { sections: [], vectors: [], fetchedAt: 0 };

// ---------- Utils ----------
const deaccent = (s="") => s
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[ÅåÄä]/g, m => ({'Å':'A','å':'a','Ä':'A','ä':'a'}[m]))
  .replace(/[Öö]/g, m => ({'Ö':'O','ö':'o'}[m]));

const norm = (s="") => deaccent(String(s).toLowerCase())
  .replace(/[^a-z0-9\s]/g," ")
  .replace(/\s+/g," ").trim();

function isSmalltalk(s="") {
  const t = norm(s);
  return /\b(hej+|halla|tja+|god morgon|godkvall|hur mar du|laget|allt bra|tack|varsagod)\b/.test(t);
}
function looksOperational(s="") {
  const t = norm(s);
  return /\b(linje|tapp|fyll|sortbyte|cip|skolj|flush|rengor|sanit|recept|batch|oee|hmi|plc|felsok|alarm|tryck|temperatur|flode|ventil|pump|kvalitet|prov|qc|haccp|ccp|sakerhet|underhall|smorj|kalibr|setup|omstall|stopporsak|setpoint|etikett|kapsyl|burk|pack)\b/.test(t);
}

// ---------- Manual fetch & chunk ----------
async function fetchManual() {
  const now = Date.now();
  if (knowledgeCache.text && now - knowledgeCache.fetchedAt < CACHE_MS) return knowledgeCache.text;
  const res = await fetch(KNOWLEDGE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Misslyckades hämta kunskap: ${res.status}`);
  const text = await res.text();
  knowledgeCache = { text, fetchedAt: now };
  return text;
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

  // chunk ~1200 chars
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

// ---------- Embeddings ----------
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
async function retrieve(query, extraQuery="") {
  const { sections, vectors } = await ensureIndex();
  const qtext = [query, extraQuery].filter(Boolean).join("\n");
  const qvec = (await embedAll([qtext]))[0];
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

// ---------- Intent & slot-filling ----------
const DRINK_MAP = [
  { key:"lask",   pats:[/l[aä]sk/] },
  { key:"ol",     pats:[/o+l/] },
  { key:"cider",  pats:[/cider/] },
  { key:"vatten", pats:[/vatten|water|stillt?/] },
  { key:"energi", pats:[/energi|energy|power/] },
  { key:"juice",  pats:[/juice|jos/] },
];

const AREA_MAP = [
  { key:"tapp", pats:[/tapp|tapplinje|tappning|fyll|fyllare|fyllning/] },
  { key:"cip",  pats:[/\bcip\b|rengor|sanit|skolj|flush|spolning/] },
  { key:"mix",  pats:[/mix|sirap|syrup|recept|batch/] },
];

function matchKey(text, MAP){
  const t = norm(text);
  for (const m of MAP){
    for (const re of m.pats) if (re.test(t)) return m.key;
  }
  return null;
}

function parseSortbyte(raw, prevAssistant){
  const sOrig = String(raw||"");
  const s = norm(sOrig);

  // Känna igen "sortbyte" med felstavningar
  const hasSortbyte = /\b(sor?t?b[y]?te|sortbyt|receptbyte|omstall(ning)?|byte sort|byta sort)\b/.test(s);
  if (!hasSortbyte && !(prevAssistant?.intent?.name === "sortbyte")) return null;

  // Hitta "X till Y" — tolerant mot mellanrum: t\s*i\s*l\s*l
  const sFlex = deaccent(sOrig.toLowerCase()).replace(/\s+/g," ");
  const sFlexTolerant = sFlex.replace(/t\s*i\s*l\s*l/g,"till"); // "ti ll" -> "till"
  let from=null, to=null;

  // mönster: "<x> till <y>"
  const m1 = sFlexTolerant.match(/([a-zåäö]+)\s*till\s*([a-zåäö]+)/i);
  if (m1) {
    from = matchKey(m1[1], DRINK_MAP);
    to   = matchKey(m1[2], DRINK_MAP);
  }

  // om inget, prova att texten är en enda dryck (svar på följdfråga)
  if (!from && !to) {
    const one = matchKey(sOrig, DRINK_MAP);
    if (one) {
      // Om vi tidigare frågade "typ av dryck" betraktar vi det som ett slot-svar
      from = prevAssistant?.intent?.from || one;
      to   = prevAssistant?.intent?.to   || (from ? one : null);
      if (!from) from = one;
      if (!to) to = one;
    }
  }

  // område (tapp/cip/mix)
  let area = matchKey(sOrig, AREA_MAP) || prevAssistant?.intent?.area || null;
  if (!area && /tapp/i.test(sOrig)) area = "tapp";

  const out = { name:"sortbyte", area, from, to };
  // Färdig om vi har minst area eller “sortbyte i tappen”
  const ready = !!(area && (from || to));
  return { intent: out, ready };
}

// ---------- OpenAI helper ----------
async function callOpenAI(system, user, { temperature=0.28, max_tokens=1600 } = {}) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4o", temperature, max_tokens, messages: [
      { role:"system", content: system },
      { role:"user",   content: user }
    ] }),
  });
  const j = await r.json();
  if (!r.ok) { console.error("OpenAI chat error:", j); throw new Error("Chat API error"); }
  let out;
  try { out = JSON.parse(j.choices?.[0]?.message?.content || ""); }
  catch {
    out = {
      spoken: "Hoppsan — säg det gärna en gång till, jag lyssnar.",
      need: { clarify: true, question: "Kan du förtydliga?" },
      cards: { summary:"Behöver förtydligande.", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
      follow_up: ""
    };
  }
  return out;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null } = req.body || {};
    const prevAssistant = prev?.assistant || null;

    // 0) Småprat klart och tydligt
    if (isSmalltalk(message) && !looksOperational(message)) {
      const out = {
        spoken: "Jag mår fint — AI-pigg. Hur är läget hos dig?",
        need: { clarify: false },
        cards: { summary:"Småprat", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
        follow_up: ""
      };
      return res.status(200).json({ reply: out });
    }

    // 1) Intent/slots
    const sortInfo = parseSortbyte(message, prevAssistant);
    const intent = sortInfo?.intent || prevAssistant?.intent || null;

    // 2) Om vi vet att det är sortbyte men saknar slots → ställ SPECIFIK fråga
    if ((sortInfo && !sortInfo.ready) || (intent?.name==="sortbyte" && !(intent.from && intent.to && intent.area))) {
      const asked = prevAssistant?.need?.clarify;
      // fyll det vi kan och spara i assistant.intent
      const tmpIntent = {
        name:"sortbyte",
        area: intent?.area || sortInfo?.intent?.area || matchKey(message, AREA_MAP),
        from: intent?.from || sortInfo?.intent?.from || matchKey(message, DRINK_MAP),
        to:   intent?.to   || sortInfo?.intent?.to   || null,
      };
      // Vad saknas?
      const missing = [];
      if (!tmpIntent.area) missing.push("vilken utrustning (t.ex. tappen)");
      if (!tmpIntent.from || !tmpIntent.to) missing.push("från vilken dryck till vilken");
      const q = missing.length
        ? `Behöver bara ${missing.join(" och ")}. Säg t.ex. "tapp — läsk till läsk".`
        : `Bekräfta: ${tmpIntent.area}, ${tmpIntent.from} till ${tmpIntent.to}?`;

      const out = {
        spoken: "Jag hänger med — det gäller sortbyte. Ge mig bara delarna jag saknar, så guidar jag exakt.",
        need: { clarify: true, question: q },
        cards: { summary:"Slot-fyllning för sortbyte", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
        follow_up: "",
        intent: tmpIntent
      };
      return res.status(200).json({ reply: out });
    }

    // 3) Bygg RAG-fråga
    const manualHint = intent?.name==="sortbyte"
      ? [`${intent.area || "tapp"} sortbyte`, `${intent.from||""} till ${intent.to||""}`].join(" ").trim()
      : "";

    const { context, matched_headings, coverage, any } = await retrieve(message, manualHint);

    // 4) Systemprompt: operativt = endast KONTEKST; steps utan numrering
    const system = `
Du är röstmentor för Linje 65 (JARVIS-ton, trygg). Svara alltid på svenska.

KÄLLREGLER
- Du får KONTEKST från manualen. **Alla operativa råd måste bygga på KONTEKST.** Inga gissningar.
- Om KONTEKST är otillräcklig: ställ EN specifik följdfråga eller säg att området inte täcks.

STEGFORMAT
- "cards.steps" = korta, konkreta åtgärder **utan** numrering/prefix ("1.", "Steg 1:" etc). Klienten numrerar.

TAL ("spoken")
- Naturligt, korta meningar, små bekräftelser. Vid säkerhet: seriös ton.

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

    // 5) Userprompt
    const user = `
KONTEKST (använd endast detta för operativa svar):
${any ? context : "(tomt — ingen träff i manualen)"}

INTENT (om given):
${intent ? JSON.stringify(intent) : "null"}

Tidigare tur:
${prev ? JSON.stringify(prev) : "null"}

Fråga:
"${message}"

Instruktioner:
- Om frågan är operativ och KONTEKST är tom/otillräcklig: need.clarify=true och ställ EN konkret fråga kopplad till rubriker/moment i manualen (inte "kan du säga det igen").
- Om KONTEKST räcker: ge tydliga åtgärder i "cards.steps" (utan numrering). Fyll "matched_headings" med rubriker från KONTEKST. Sätt "coverage" ~${coverage.toFixed(2)}.
- Ingen text utanför JSON.
`.trim();

    // 6) Modell
    let out = await callOpenAI(system, user, { temperature: 0.28, max_tokens: 1600 });

    // 7) Efterkontroller
    const allowed = new Set(matched_headings);
    if (!out.cards) out.cards = { summary:"", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] };

    // Endast rubriker från KONTEKST
    out.cards.matched_headings = Array.isArray(out.cards.matched_headings)
      ? out.cards.matched_headings.filter(h => allowed.has(h))
      : [];

    if (out.cards.steps?.length && out.cards.matched_headings.length === 0) {
      out.cards.matched_headings = matched_headings.slice(0, 4);
    }
    if (!(typeof out.cards.coverage === "number" && isFinite(out.cards.coverage))) {
      out.cards.coverage = coverage;
    }

    // Om operativt men KONTEKST tom → stoppa hallu och fråga specifikt
    if (looksOperational(message) && !any && (out.cards.steps?.length || /steg|oppna|stang|tryck|ventil|temperatur/i.test(out.spoken||""))) {
      const q = intent?.name==="sortbyte"
        ? "Vilken rubrik i manualen gäller sortbytet? (t.ex. 'Tapp – sortbyte')"
        : "Vilken rubrik/utrustning avser du? (t.ex. 'Tapp – gul lampa', 'CIP – tapp')";
      out = {
        spoken: "Det där låter operativt, men jag hittar ingen träff i manualen just nu.",
        need: { clarify: true, question: q },
        cards: { summary:"Operativ fråga utan träff i KONTEKST.", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
        follow_up: "",
        intent: intent || null
      };
    } else {
      // Bifoga intent tillbaka så klienten kan minnas slots
      if (intent) out.intent = intent;
    }

    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
