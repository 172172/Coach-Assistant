// /api/chat.js
// Balans: GENERAL (fri AI) vs OPERATIV (manual-först).
// Operativt svar får ENDAST bygga på utdrag ur manualen (KONTEKST).
// Routing utan hårdkodade domänord: vi avgör på hur väl manualen matchar (RAG-first).

const KNOWLEDGE_URL = "https://raw.githubusercontent.com/172172/Coach-Assistant/main/assistant-knowledge.txt";
const CACHE_MS = 5 * 60 * 1000;

let knowledgeCache = { text: null, fetchedAt: 0 };
let ragCache = { sections: [], vectors: [], fetchedAt: 0 };

// ---------- Små hjälpare ----------
const norm = (s = "") =>
  String(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[åä]/g, "a").replace(/[ö]/g, "o")
    .replace(/\s+/g, " ")
    .trim();

function isSmalltalk(s = "") {
  const t = norm(s);
  // Bara för att ge trevligt bemötande vid rena hälsningsfraser.
  return /\b(hej+|h[aä]ll[aå]|tja+|god morgon|godkv[aä]ll|hur m[aå]r du|allt bra|l[aä]get|tack|vars[aå]god)\b/.test(t);
}

function isShortReply(s = "") {
  return norm(s).split(" ").filter(Boolean).length <= 4;
}

// ---------- Hämta & chunk:a manual ----------
async function fetchManual() {
  const now = Date.now();
  if (knowledgeCache.text && now - knowledgeCache.fetchedAt < CACHE_MS) return knowledgeCache.text;
  const res = await fetch(KNOWLEDGE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Misslyckades hämta manual: ${res.status}`);
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
      if (current.content.length) {
        sections.push({ heading: current.heading, text: current.content.join("\n").trim() });
      }
      current = { heading: m[2].trim(), content: [] };
    } else {
      current.content.push(line);
    }
  }
  if (current.content.length) {
    sections.push({ heading: current.heading, text: current.content.join("\n").trim() });
  }

  // chunk ~1200 tecken för bättre träff
  const out = [];
  const MAX = 1200;
  for (const s of sections) {
    const base = `${s.heading}\n${s.text}`.trim();
    if (base.length <= MAX) {
      out.push({ heading: s.heading, chunk: base });
      continue;
    }
    const paras = s.text.split(/\n\s*\n/);
    let buf = s.heading + "\n";
    for (const p of paras) {
      if ((buf + p).length > MAX) {
        out.push({ heading: s.heading, chunk: buf.trim() });
        buf = s.heading + "\n" + p + "\n";
      } else {
        buf += p + "\n\n";
      }
    }
    if (buf.trim().length) out.push({ heading: s.heading, chunk: buf.trim() });
  }
  return out.filter(s => s.chunk && s.chunk.replace(/\W/g, "").length > 40);
}

// ---------- Embeddings & retrieval ----------
async function embedAll(texts) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts })
  });
  const j = await r.json();
  if (!r.ok) {
    console.error("Embeddings error:", j);
    throw new Error("Embeddings API error");
  }
  return j.data.map(d => d.embedding);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
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

async function retrieve(queryStrings /* string[] */) {
  await ensureIndex();
  const { sections, vectors } = ragCache;
  const inputs = (queryStrings || []).filter(Boolean);
  if (!inputs.length) return { context: "", matched_headings: [], coverage: 0, any: false };

  const qvecs = await embedAll(inputs);
  // medel av alla frågevektorer
  const qavg = new Array(qvecs[0].length).fill(0);
  qvecs.forEach(v => { for (let i = 0; i < v.length; i++) qavg[i] += v[i]; });
  for (let i = 0; i < qavg.length; i++) qavg[i] /= qvecs.length;

  const scored = vectors.map((v, i) => ({ i, s: cosine(qavg, v) })).sort((a, b) => b.s - a.s);
  const K = 8;
  const top = scored.slice(0, K).filter(o => o.s > 0.18);
  const picks = top.map(o => ({ ...sections[o.i], score: o.s }));

  const matched_headings = Array.from(new Set(picks.map(p => p.heading)));
  const avg = top.length ? top.reduce((a, b) => a + b.s, 0) / top.length : 0;
  const coverage = Math.max(0, Math.min(1, avg * 1.6));
  const context = picks.map((p, idx) => `### [S${idx + 1}] ${p.heading}\n${p.chunk}`).join("\n\n");

  return { context, matched_headings, coverage, any: picks.length > 0 };
}

// ---------- GENERAL-svar (fri AI) ----------
async function answerGeneral(message) {
  const system = `
Du är en vänlig, smart assistent (JARVIS-vibe). Svenska, kort men innehållsrik. Lite humor när det passar.
Var ärlig: om du inte vet, säg det. Svara i vanlig text (inte JSON).
`.trim();
  const user = `"${message}"`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4o", temperature: 0.6, max_tokens: 400, messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]})
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Chat API error");
  const spoken = j.choices?.[0]?.message?.content?.trim() || "Okej.";
  return {
    spoken,
    need: { clarify: false },
    cards: { summary: "Samtal", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
    follow_up: ""
  };
}

// ---------- OPERATIV-svar (manual-först) ----------
async function generateOperativeAnswer({ message, prev, context, matched_headings, coverage, any }) {
  const system = `
Du är röstmentor för Linje 65. Svenska, trygg och tydlig. Lätt humor när det passar (inte vid säkerhet).

KÄLLREGLER (stenhårda):
- Du får KONTEKST nedan (utdrag ur manualen). **Alla operativa råd måste bygga på KONTEKST.** Hitta inte på värden, tider, parametrar.
- Om KONTEKST inte räcker: ställ EN specifik följdfråga som hjälper att hitta rätt rubrik eller moment. Upprepa inte samma fråga.

STEGFORMAT:
- "cards.steps" ska vara en lista med korta åtgärder **utan** numrering/prefix ("1.", "Steg 1:" etc). Klienten numrerar.

RETURERA EXAKT JSON (ingen text utanför):
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

Tidigare tur (för sammanhang):
${prev ? JSON.stringify(prev) : "null"}

Fråga:
"${message}"

Instruktioner:
- Om KONTEKST saknas eller är svag (t.ex. coverage < 0.4): need.clarify=true och ställ EN ny, specifik fråga (inte samma igen).
- Om KONTEKST räcker: ge tydliga åtgärder i "cards.steps" (utan numrering) och fyll "matched_headings" med rubriker från KONTEKST. Sätt "coverage" ungefär (${coverage.toFixed(2)}).
- Ingen text utanför JSON.
`.trim();

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4o", temperature: 0.25, max_tokens: 1700, messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]})
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Chat API error");

  let out;
  try { out = JSON.parse(j.choices?.[0]?.message?.content || ""); }
  catch {
    out = {
      spoken: "Jag behöver en detalj till för att hitta rätt i manualen.",
      need: { clarify: true, question: "Vilken rubrik eller del gäller det?" },
      cards: { summary: "Behöver förtydligande.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage, matched_headings: [] },
      follow_up: ""
    };
  }

  // Efterkontroller: håll rubriker till våra
  const allowed = new Set(matched_headings);
  out.cards = out.cards || { summary: "", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage, matched_headings: [] };
  out.cards.matched_headings = Array.isArray(out.cards.matched_headings)
    ? out.cards.matched_headings.filter(h => allowed.has(h))
    : [];

  if (out.cards.steps?.length && out.cards.matched_headings.length === 0) {
    out.cards.matched_headings = matched_headings.slice(0, 4);
  }
  if (!(typeof out.cards.coverage === "number" && isFinite(out.cards.coverage))) {
    out.cards.coverage = coverage;
  }

  // Operativ fråga men ingen kontext → fråga, inte gissa
  if (!any && (out.cards.steps?.length || /ventil|tryck|temp|steg/i.test(out.spoken || ""))) {
    out = {
      spoken: "Det där är operativt, men jag hittar ingen träff i manualen än.",
      need: { clarify: true, question: "Säg vilken rubrik eller moment det gäller (t.ex. 'Tapp – sortbyte')." },
      cards: { summary: "Ingen träff i manualen.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
      follow_up: ""
    };
  }

  return out;
}

// ---------- API handler ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null } = req.body || {};

    // 1) RAG på allt — även korta uppföljningar (kombinera med förra frågan/rubrikerna)
    const queries = [message];
    if (prev?.assistant?.need?.clarify && isShortReply(message)) {
      if (prev?.question) queries.push(prev.question);
      if (Array.isArray(prev?.assistant?.cards?.matched_headings)) {
        queries.push(...prev.assistant.cards.matched_headings);
      }
    }

    const { context, matched_headings, coverage, any } = await retrieve(queries);

    // 2) Routing: om manualen matchar → OPERATIV; annars → GENERAL
    const isOperative = any && (coverage >= 0.30 || matched_headings.length >= 1);

    if (!isOperative) {
      // Småprat får trevligt bemötande
      if (isSmalltalk(message)) {
        const out = {
          spoken: "Jag mår fint — AI-pigg. Hur är läget hos dig?",
          need: { clarify: false },
          cards: { summary: "Småprat", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        };
        return res.status(200).json({ reply: out });
      }
      const out = await answerGeneral(message);
      return res.status(200).json({ reply: out });
    }

    // 3) OPERATIV: svara endast från KONTEKST (annars följdfråga)
    const out = await generateOperativeAnswer({ message, prev, context, matched_headings, coverage, any });
    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
