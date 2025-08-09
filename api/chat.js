// /api/chat.js
// Kollegig AI-coach: identity, smalltalk, conversation-memory, rewrite-intents (simplify/repeat/summary/examples),
// general-knowledge (jobbrelaterat), toolbelt (math/units), RAG (definition/operativt från manualen)

import { q } from "./db.js";
import fetch from "node-fetch";
import { getMemory, upsertMemory } from "./memory.js";

/* ================= Embeddings ================= */
async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Embeddings API error");
  return j.data[0].embedding;
}
const toPgVector = (arr) => "[" + arr.map(x => (x ?? 0).toFixed(6)).join(",") + "]";

/* ================= Text utils / heuristics ================= */
const norm = (s = "") =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[åÅ]/g, "a").replace(/[äÄ]/g, "a").replace(/[öÖ]/g, "o");

function isSmalltalk(s = "") {
  const t = norm(s);
  return /\b(hej|tja|tjena|hallo|halla|hallå|hur mar du|hur ar laget|allt bra|tack|tackar|vad gor du)\b/.test(t);
}
function isIdentityQuery(s = "") {
  const t = norm(s);
  return /\b(vem ar du|vad ar du|vad kan du|beratta om dig|presentera dig|vem pratar jag med)\b/.test(t);
}
function isProfileQuery(s = "") {
  const t = norm(s);
  return /\b(vad|vilken|vad heter|heter)\b.*\b(min|mitt)\b.*\b(linje|line)\b/.test(t)
      || /\b(vilken linje jobbar jag pa|min profil|mina uppgifter)\b/.test(t);
}
function parseSaveCommand(s = "") {
  const t = norm(s);
  if (!/\b(spara|kom ihag|kom ihåg|remember)\b/.test(t)) return null;
  const m = t.match(/\b(linje|line)\s*([a-z0-9\-_:]+)\b/i) || t.match(/\b(linje|line)\b.*?\b([a-z0-9\-_:]+)\b/i);
  const token = m?.[2] ? m[2].toUpperCase() : null;
  const line_name = token ? `Linje ${token.replace(/^linje/i, "").trim()}` : null;
  return { intent: "save", line_name };
}
function isDefinitionQuery(s = "") {
  const t = norm(s).trim();
  if (/\b(vad ar|vad är|vad betyder|vad gor|vad gör)\b/.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 2; // t.ex. "CIP", "fals"
}

/* ================= General knowledge (tillåten zon) ================= */
const GENERAL_KEYWORDS = [
  "oee","5s","lean","kaizen","smed","tpm","gmp","haccp","root cause","rotorsak","5 why","ishikawa",
  "poka yoke","andonsystem","kpi","effektivitet","kvalitet","hygien","sanitation","säkerhet","arbetsmiljo","arbetsmiljö",
  "kontinuerligt förbättringsarbete","continuous improvement","standardarbete","sop","eskalering","standup",
  "flaskhals","wip","lager","batch","spårbarhet","traceability","audit","revision","uppstart","nedstangning","rca",
  "visual management","5 varför","5 varfor"
];
function isGeneralManufacturingQuery(s = "") {
  const t = norm(s);
  if (!t || t.length < 3) return false;
  if (GENERAL_KEYWORDS.some(k => t.includes(norm(k)))) return true;
  if (/\b(vad ar|vad är|hur funkar|hur fungerar|tips for|tips för|basta satt|bästa sätt)\b/.test(t) &&
      !/\b(ocme|kisters|jones|depalletizer|fals|coolpack|linje\s*\d+|line\s*\d+)\b/.test(t)) {
    return true;
  }
  return false;
}

/* ================= Conversation memory intents ================= */
function parseConversationMemoryIntent(s = "") {
  const t = norm(s);

  // Första frågan
  if (
    /\b(i borjan|i början)\b.*\b(fragan|fraga|jag fragade|jag stalde)\b/.test(t) ||
    /\b(forsta fragan|min forsta fraga|vad var min forsta fraga|fragan jag borjade med)\b/.test(t)
  ) return { type: "first" };

  // Senaste frågan (din)
  if (
    /\b(vad\s+var\s+min(?:\s+\w+){0,3}?\s+fraga(?:\s+\w+){0,2}?\s+(innan|nyss|precis|forut|tidigare|sist))\b/.test(t) ||
    /\b(min\s+senaste\s+fraga|min\s+forra\s+fraga|forra\s+fragan|senaste\s+fragan)\b/.test(t)
  ) return { type: "last" };

  // “vad frågade/sa/skrev jag …”
  if (
    /\b(vad\s+fragade\s+jag(?:\s+\w+){0,3}?\s+(innan|nyss|precis|forut|tidigare|sist))\b/.test(t) ||
    /\b(vad\s+sa\s+jag(?:\s+\w+){0,3}?\s+(innan|nyss|precis|forut|tidigare|sist))\b/.test(t) ||
    /\b(vad\s+skrev\s+jag(?:\s+\w+){0,3}?\s+(innan|nyss|precis|forut|tidigare|sist))\b/.test(t)
  ) return { type: "last_user" };

  // “vad sa/svarade du …”, “upprepa”, “repetera”, “jag fattade/hörde inte”
  if (
    /\b(vad\s+sa\s+du\s+(nyss|precis|forut|tidigare|innan|sist))\b/.test(t) ||
    /\b(vad\s+svarade\s+du\s+(nyss|precis|forut|tidigare|innan|sist))\b/.test(t) ||
    /\b(upprepa|repetera|kan du repetera|sag det igen|säg det igen|ta det en gang till|ta det en gång till|jag fattade inte|jag forstod inte|jag hörde inte|jag horde inte)\b/.test(t)
  ) return { type: "assistant_last" };

  // Sammanfattning
  if (/\b(sammanfatta\s+(samtalet|detta)|sammanfattning|summering|recap|vad har vi pratat om)\b/.test(t))
    return { type: "summary" };

  // Generisk fallback
  if (/\bfraga\b/.test(t) && /\b(min|jag)\b/.test(t) && /\b(innan|nyss|precis|forut|tidigare|sist|senaste|forra)\b/.test(t))
    return { type: "last" };

  return null;
}

/* ================= Rewrite intents (låter som en kollega) ================= */
function parseRewriteIntent(s = "") {
  const t = norm(s);

  // tempo (vi skickar bara tillbaka meta = pace, frontenden tar det)
  if (/\b(langsammare|saktare|saktare|ta det lugnare|prata langsammare|kora langsammare)\b/.test(t)) return { type: "pace_slow" };
  if (/\b(snabbare|fortare|hastigare|kora snabbare|tempo upp)\b/.test(t)) return { type: "pace_fast" };

  // uttryck för “säg om det där”
  if (/\b(upprepa|repetera|sag det igen|säg det igen|ta det en gang till|ta det en gång till)\b/.test(t)) return { type: "repeat" };

  // förenkla / korta / sammanfatta
  if (/\b(enklare|forenkla|förklara enklare|lattare|barnniva|barnnivå|barnniva)\b/.test(t)) return { type: "simplify" };
  if (/\b(korta|kortare|sammanfatta|summera|tl;dr)\b/.test(t)) return { type: "summarize" };

  // utveckla / exempel / lista
  if (/\b(mer detaljer|utveckla|forklara mer|djupare)\b/.test(t)) return { type: "expand" };
  if (/\b(exempel|ge exempel|case|scenario)\b/.test(t)) return { type: "examples" };
  if (/\b(lista|punktlista|punkter|steglista)\b/.test(t)) return { type: "bulletify" };

  // förtydliga det sista svaret
  if (/\b(jag fattade inte|jag forstod inte|oklart|kan du forklara igen)\b/.test(t)) return { type: "simplify" };

  return null;
}

async function rewriteFromLast(userText, history, userId) {
  // hämta källtext (senaste assistentsvaret)
  let last = lastAssistantSpoken(history || []);
  if (!last) {
    // fallback till DB om history saknas
    const dbHist = await getRecentHistoryFromDB(userId, 50);
    last = lastAssistantSpoken(dbHist);
  }
  return String(last || "");
}

/* ================= Toolbelt: math & units ================= */
const MATH_SAFE = /^[\d\s()+\-*/.,%]+$/;
function isMathExpr(s = "") {
  const t = s.replace(/,/g, ".").trim();
  if (!MATH_SAFE.test(t)) return false;
  return /[+\-*/%]/.test(t);
}
function evalMath(expr) {
  let e = expr.replace(/,/g, ".").replace(/(\d+(\.\d+)?)%/g, "($1/100)");
  const open = (e.match(/\(/g) || []).length, close = (e.match(/\)/g) || []).length;
  if (open !== close) throw new Error("Unbalanced parentheses");
  if (e.length > 120) throw new Error("Expr too long");
  if (!MATH_SAFE.test(e)) throw new Error("Unsafe expr");
  // eslint-disable-next-line no-new-func
  const val = Function(`"use strict"; return (${e});`)();
  if (typeof val !== "number" || !isFinite(val)) throw new Error("Bad result");
  return val;
}
const UNIT_ALIASES = {
  l: ["l","liter","liters","litre"],
  ml: ["ml","milliliter","millilitrar"],
  dl: ["dl","deciliter","decilitrar"],
  cl: ["cl","centiliter","centilitrar"],
  mm: ["mm","millimeter","millimetrar"],
  cm: ["cm","centimeter","centimetrar"],
  m: ["m","meter","metrar"]
};
function normUnit(u) {
  const x = norm(u).replace(/\./g, "");
  for (const key of Object.keys(UNIT_ALIASES)) if (UNIT_ALIASES[key].includes(x)) return key;
  return null;
}
function parseUnitConv(s = "") {
  const t = s.toLowerCase().replace(/->/g, " i ").replace(/\s+til+l\s+/g, " i ");
  const m = t.match(/([\d.,]+)\s*([a-zA-Z]+)\s*(?:i|till)\s*([a-zA-Z]+)/);
  if (!m) return null;
  const val = parseFloat(m[1].replace(",", "."));
  const from = normUnit(m[2]);
  const to = normUnit(m[3]);
  if (!isFinite(val) || !from || !to || from === to) return null;
  return { val, from, to };
}
function convertUnits({ val, from, to }) {
  const lenBase = { mm: 0.001, cm: 0.01, m: 1 };
  const volBase = { l: 1, dl: 0.1, cl: 0.01, ml: 0.001 };
  if (from in lenBase && to in lenBase) return (val * lenBase[from]) / lenBase[to];
  if (from in volBase && to in volBase) return (val * volBase[from]) / volBase[to];
  throw new Error("Unsupported units");
}

/* ================= Retrieval (RAG) ================= */
async function retrieveContext(userText, k = 8) {
  const v = await embed(userText);
  const vec = toPgVector(v);
  const sql = `
    with active as (select id from manual_docs where is_active = true order by version desc limit 1)
    select c.heading, c.chunk, (1.0 - (c.embedding <=> $1::vector)) as score
    from manual_chunks c
    where c.doc_id = (select id from active)
    order by c.embedding <=> $1::vector asc
    limit $2
  `;
  const r = await q(sql, [vec, k]);
  const rows = r.rows || [];
  const scores = rows.map(x => Number(x.score) || 0);
  const base = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 0;
  const headingBonus = Math.min(0.1, (new Set(rows.map(r => r.heading)).size - 1) * 0.025);
  const coverage = Math.max(0, Math.min(1, base + headingBonus));
  const context = rows.map(x => `### ${x.heading}\n${x.chunk}`).join("\n\n---\n\n");
  const matchedHeadings = [...new Set(rows.map(x => x.heading))].slice(0, 6);
  return { context, coverage, matchedHeadings, scores };
}
function passesOperativeGate({ coverage, matchedHeadings, scores }) {
  const strongHits = (scores || []).filter(s => s >= 0.60).length;
  const distinct = new Set((matchedHeadings || []).map(h => (h || "").toLowerCase().trim())).size;
  return coverage >= 0.70 && distinct >= 2 && strongHits >= 2;
}

/* ================= LLM (strict JSON) ================= */
async function callLLM(system, user, temp = 0.6, maxTokens = 1600) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: temp,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  const j = await r.json();
  if (!r.ok) { console.error("OpenAI chat error:", j); throw new Error("Chat API error"); }
  const content = j.choices?.[0]?.message?.content || "";
  try { return JSON.parse(content); }
  catch {
    return {
      spoken: content || "Okej.",
      need: { clarify: false, question: "" },
      cards: { summary: "Samtal", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
      follow_up: ""
    };
  }
}

/* ================= Gap-drafts (valfritt) ================= */
async function createGapDraft({ userId, question, coverage, matchedHeadings, scores }) {
  try {
    if (process.env.GAP_DRAFTS !== "1") return null;
    const system = `Skapa ett UTKAST för ett nytt manualavsnitt när täckning saknas. Använd "[PLATS FÖR VÄRDE]" för alla tal. Returnera JSON med title, heading, summary, outline[], md.`;
    const user = `Fråga: "${question}"\nRubriker: ${JSON.stringify(matchedHeadings||[])}\nCoverage: ${coverage.toFixed(3)}`;
    const draft = await callLLM(system, user, 0.2, 700);
    const r = await q(
      `insert into kb_gaps(status,user_id,question,intent,coverage,matched_headings,scores,gap_reason,
                           draft_title,draft_heading,draft_md,draft_outline,priority,created_by_ai)
       values ('open',$1,$2,'operational',$3,$4,$5,'låg täckning i manualen',$6,$7,$8,$9::jsonb,0,true)
       returning id`,
      [userId, question, coverage, matchedHeadings||[], scores||[], draft?.title||null, draft?.heading||null, draft?.md||null, JSON.stringify(draft?.outline||[])]
    );
    return r?.rows?.[0]?.id || null;
  } catch (e) { console.warn("createGapDraft failed:", e?.message || e); return null; }
}

/* ================= Logging / DB helpers ================= */
async function logInteraction({ userId, question, reply, lane, intent, coverage, matchedHeadings }) {
  try {
    if (process.env.LOG_CONVO !== "1") return;
    await q(
      `insert into messages(user_id, asked_at, question, content, reply_json, smalltalk, is_operational, coverage, matched_headings, lane, intent)
       values ($1, now(), $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        question,
        question,
        JSON.stringify(reply || {}),
        lane === "smalltalk",
        lane === "operative",
        Number(coverage) || 0,
        matchedHeadings || [],
        lane || null,
        intent || null
      ]
    );
  } catch (e) { console.warn("logInteraction failed:", e?.message || e); }
}

async function getRecentHistoryFromDB(userId, limit = 50) {
  try {
    const r = await q(
      `select asked_at, question, reply_json
       from messages
       where user_id = $1
       order by asked_at asc
       limit $2`,
      [userId, limit]
    );
    const rows = r.rows || [];
    return rows.map(row => ({
      user: row.question || "",
      assistant: (row.reply_json && typeof row.reply_json === "object") ? row.reply_json : {},
      ts: row.asked_at ? new Date(row.asked_at).getTime() : undefined,
      origin: "db"
    }));
  } catch (e) {
    console.warn("getRecentHistoryFromDB failed:", e?.message || e);
    return [];
  }
}

/* ================= Sanitizers / schema helpers ================= */
const NUMBER_RE = /\b\d+([.,]\d+)?\b/g;
function sanitizeParameters(out, context) {
  const ctxNums = new Set((context.match(NUMBER_RE) || []).map(x => x));
  const replaceNums = (s) => String(s || "").replace(NUMBER_RE, (m) => (ctxNums.has(m) ? m : "[PLATS FÖR VÄRDE]"));
  if (out.spoken) out.spoken = replaceNums(out.spoken);
  if (out.cards) {
    out.cards.summary && (out.cards.summary = replaceNums(out.cards.summary));
    out.cards.explanation && (out.cards.explanation = replaceNums(out.cards.explanation));
    out.cards.simple && (out.cards.simple = replaceNums(out.cards.simple));
    out.cards.pro && (out.cards.pro = replaceNums(out.cards.pro));
    if (Array.isArray(out.cards.steps)) out.cards.steps = out.cards.steps.map(replaceNums);
    if (Array.isArray(out.cards.pitfalls)) out.cards.pitfalls = out.cards.pitfalls.map(replaceNums);
  }
  return out;
}
function normalizeKeys(out) {
  if (out && !out.spoken && typeof out.svar === "string") out.spoken = out.svar;
  if (!out.need) out.need = { clarify: false, question: "" };
  if (!("clarify" in out.need)) out.need.clarify = false;
  if (!("question" in out.need)) out.need.question = "";
  if (!out.cards) out.cards = {};
  const defCards = { summary:"", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] };
  out.cards = Object.assign(defCards, out.cards);
  if (!Array.isArray(out.cards.steps)) out.cards.steps = [];
  if (!Array.isArray(out.cards.matched_headings)) out.cards.matched_headings = [];
  if (typeof out.cards.coverage !== "number" || isNaN(out.cards.coverage)) out.cards.coverage = 0;
  if (typeof out.follow_up !== "string") out.follow_up = out.cards.follow_up || "";
  // meta tillåts vara valfritt
  return out;
}

/* ================= History helpers ================= */
function sortByTsIfAny(arr = []) {
  const hasTs = arr.some(x => typeof x?.ts === "number");
  if (!hasTs) return arr.slice();
  return arr.slice().sort((a,b) => (a.ts||0) - (b.ts||0));
}
function firstUserQuestion(history = []) {
  const entries = sortByTsIfAny(history).filter(h => h && typeof h.user === "string" && h.user.trim());
  return entries[0]?.user || "";
}
function lastUserQuestion(history = []) {
  const entries = sortByTsIfAny(history).filter(h => h && typeof h.user === "string" && h.user.trim());
  return entries.length ? entries[entries.length - 1].user : "";
}
function lastAssistantSpoken(history = []) {
  const entries = sortByTsIfAny(history).filter(h => h && h.assistant && typeof h.assistant.spoken === "string" && h.assistant.spoken.trim());
  return entries.length ? entries[entries.length - 1].assistant.spoken : "";
}

/* ================= Handler ================= */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null, history = [], userId: userIdRaw } = req.body || {};
    const userText = String(message || "").trim();
    const userId = (typeof userIdRaw === "string" && userIdRaw) || req.headers["x-user-id"] || "default";

    if (!userText) {
      const reply = {
        spoken: "Jag hörde inget tydligt – säg igen så tar vi det.",
        need: { clarify: true, question: "Kan du säga det igen?" },
        cards: { summary: "Otydligt", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
        follow_up: ""
      };
      return res.status(200).json({ reply });
    }

    /* -------- Lane: Identity -------- */
    if (isIdentityQuery(userText)) {
      const reply = normalizeKeys({
        spoken: "Jag är din kollega i örat för Linje 65 – mänsklig i samtal, källsäkrad i drift. Vad vill du kika på?",
        need: { clarify: false, question: "" },
        cards: { summary: "AI-coach för Linje 65.", steps: [], explanation: "Småprat och allmänna jobbfrågor svaras fritt. Operativa råd bygger alltid på manualen.", pitfalls: [], simple: "", pro: "", follow_up: "Vad behöver du?", coverage: 0, matched_headings: [] },
        follow_up: "Vad behöver du?"
      });
      await logInteraction({ userId, question: userText, reply, lane: "identity", intent: "whoami", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply });
    }

    /* -------- Lane: Profile-light (save/query) -------- */
    const saveCmd = parseSaveCommand(userText);
    if (saveCmd?.intent === "save") {
      const patch = {};
      if (saveCmd.line_name) patch.line_name = saveCmd.line_name;
      const up = await upsertMemory(userId, patch);
      const saved = up?.row || patch;
      const reply = normalizeKeys({
        spoken: saved?.line_name ? `Klart. Jag sparade din linje som “${saved.line_name}”.` : "Klart. Jag sparade uppgiften.",
        need: { clarify: false, question: "" },
        cards: { summary: "Profil uppdaterad.", steps: [], explanation: "", pitfalls: [], simple: saved?.line_name || "", pro: "", follow_up: "Vill du lägga in fler uppgifter?", coverage: 0, matched_headings: [] },
        follow_up: "Vill du lägga in fler uppgifter?"
      });
      await logInteraction({ userId, question: userText, reply, lane: "profile", intent: "save", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply });
    }

    if (isProfileQuery(userText)) {
      const mem = await getMemory(userId);
      const reply = normalizeKeys(
        mem?.line_name
          ? { spoken: `Din linje är ${mem.line_name}.`, need: { clarify: false, question: "" },
              cards: { summary: `Profiluppgift: ${mem.line_name}.`, steps: [], explanation: "", pitfalls: [], simple: mem.line_name, pro: "", follow_up: "Vill du att jag minns något mer?", coverage: 0, matched_headings: [] },
              follow_up: "Vill du att jag minns något mer?" }
          : { spoken: "Jag saknar profilinfo om din linje. Säg till om jag ska spara den. Ex: “Spara linje 65”.",
              need: { clarify: true, question: "Ska jag spara din linje? Säg: “Spara linje 65”." },
              cards: { summary: "Saknar profiluppgift.", steps: [], explanation: "", pitfalls: ["Risk för antaganden utan källa."], simple: "", pro: "", follow_up: "Säg: “Spara linje 65”.", coverage: 0, matched_headings: [] },
              follow_up: "Säg: “Spara linje 65”." }
      );
      await logInteraction({ userId, question: userText, reply, lane: "profile", intent: "query", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply });
    }

    /* -------- Lane: Conversation memory -------- */
    const conv = parseConversationMemoryIntent(userText);
    if (conv) {
      let sourceHistory = Array.isArray(history) && history.length ? history : null;
      if (!sourceHistory || !sourceHistory.length) {
        const dbHist = await getRecentHistoryFromDB(userId, 50);
        if (dbHist.length) sourceHistory = dbHist;
      }

      let spoken = "Jag har ingen historik för den här sessionen ännu.";
      if (sourceHistory && sourceHistory.length) {
        if (conv.type === "first") {
          const first = firstUserQuestion(sourceHistory);
          if (first) spoken = `Din första fråga var: “${first}”.`;
        } else if (conv.type === "last" || conv.type === "last_user") {
          const last = lastUserQuestion(sourceHistory);
          if (last) spoken = (conv.type === "last_user") ? `Du sa: “${last}”.` : `Din senaste fråga var: “${last}”.`;
        } else if (conv.type === "assistant_last") {
          const lastA = lastAssistantSpoken(sourceHistory);
          spoken = lastA ? `Jag sa: “${lastA}”.` : "Jag har inget tidigare svar att upprepa ännu.";
        } else if (conv.type === "summary") {
          const entries = sortByTsIfAny(sourceHistory).map(h => h?.user).filter(Boolean).slice(-6);
          spoken = entries.length ? `Vi har pratat om: ${entries.join(", ")}.` : "Vi har inte pratat om något än.";
        }
      }

      const reply = normalizeKeys({
        spoken,
        need: { clarify: false, question: "" },
        cards: { summary: "Samtalshistorik", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
        follow_up: ""
      });
      await logInteraction({ userId, question: userText, reply, lane: "conv_memory", intent: conv.type, coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply });
    }

    /* -------- Lane: Rewrite intents (förklara enklare / upprepa / sammanfatta / exempel / tempo) -------- */
    const rw = parseRewriteIntent(userText);
    if (rw) {
      // Hämta källsvar (senaste assistent)
      const base = await rewriteFromLast(userText, history, userId);
      if (!base) {
        const fallback = normalizeKeys({
          spoken: "Jag har inget tidigare svar att jobba vidare på ännu.",
          need: { clarify: false, question: "" },
          cards: { summary: "Ingen historik hittad.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        });
        await logInteraction({ userId, question: userText, reply: fallback, lane: "rewrite", intent: rw.type, coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply: fallback });
      }

      if (rw.type === "pace_slow" || rw.type === "pace_fast") {
        const reply = normalizeKeys({
          spoken: rw.type === "pace_slow" ? "Okej, jag tar det lugnare." : "Absolut, jag håller lite högre tempo.",
          need: { clarify: false, question: "" },
          cards: { summary: "Pace uppdaterad.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: "",
          meta: { pace: rw.type === "pace_slow" ? "slow" : "fast" }
        });
        await logInteraction({ userId, question: userText, reply, lane: "rewrite", intent: rw.type, coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      }

      if (rw.type === "repeat") {
        const reply = normalizeKeys({
          spoken: base,
          need: { clarify: false, question: "" },
          cards: { summary: "Upprepning av senaste svar.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        });
        await logInteraction({ userId, question: userText, reply, lane: "rewrite", intent: "repeat", coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      }

      // Anropa LLM för att omskriva base
      const system = `Omskriv senaste svar till önskat format/ton. Returnera strikt JSON (spoken, need, cards{...}, follow_up). Var kort, pratvänlig, svensk kollega.`;
      const user = JSON.stringify({
        intent: rw.type,
        base
      });
      let out = await callLLM(system, user, 0.4, 800);
      out = normalizeKeys(out);
      out.cards.coverage = 0; out.cards.matched_headings = [];
      out.follow_up = out.follow_up || (rw.type === "simplify" ? "Vill du ha ett exempel också?" :
                                        rw.type === "summarize" ? "Vill du att jag går igenom steg för steg?" :
                                        rw.type === "examples" ? "Ska jag koppla detta till ett område på linjen?" :
                                        "");
      await logInteraction({ userId, question: userText, reply: out, lane: "rewrite", intent: rw.type, coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply: out });
    }

    /* -------- Lane: Smalltalk -------- */
    if (isSmalltalk(userText)) {
      const system = `Du är en svensk JARVIS för Linje 65. Småprat: varm, kort och jordnära. Låt det låta som en kollega. Returnera strikt JSON enligt schema.`;
      const user = `Småprat: """${userText}"""`;
      let out = await callLLM(system, user, 0.7, 600);
      out = normalizeKeys(out);
      out.cards.coverage = 0; out.cards.matched_headings = [];
      if (!out.spoken) out.spoken = "Allt bra här – på tårna. Vad vill du kika på?";
      await logInteraction({ userId, question: userText, reply: out, lane: "smalltalk", intent: "smalltalk", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply: out });
    }

    /* -------- Lane: Toolbelt (units & math) -------- */
    const unitReq = parseUnitConv(userText);
    if (unitReq) {
      try {
        const val = convertUnits(unitReq);
        const rounded = Math.abs(val) < 1e6 ? +(Math.round(val * 1000) / 1000) : val;
        const reply = normalizeKeys({
          spoken: `${unitReq.val} ${unitReq.from} är ${rounded} ${unitReq.to}.`,
          need: { clarify: false, question: "" },
          cards: { summary: "Omvandling", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        });
        await logInteraction({ userId, question: userText, reply, lane: "toolbelt", intent: "unit_convert", coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      } catch {}
    }
    if (isMathExpr(userText)) {
      try {
        const val = evalMath(userText);
        const rounded = Math.abs(val) < 1e9 ? +(Math.round(val * 1e6) / 1e6) : val;
        const reply = normalizeKeys({
          spoken: `Det blir ${rounded}.`,
          need: { clarify: false, question: "" },
          cards: { summary: "Beräkning", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        });
        await logInteraction({ userId, question: userText, reply, lane: "toolbelt", intent: "math", coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      } catch {}
    }

    /* -------- Lane: General knowledge (jobbrelaterat, ej parametrar) -------- */
    if (isGeneralManufacturingQuery(userText)) {
      const system = `
Du är en svensk kollega. Svara kort (1–4 meningar) på allmänna *produktionsrelaterade* frågor (Lean/OEE/5S/TPM/HACCP/SMED/5 Why, säkerhet/kvalitet).
- Ge principer och enkla exempel.
- Ge INTE lokala parametrar. Om det behövs, hänvisa till manualen och be om område.
Returnera strikt JSON enligt schema.`.trim();

      const user = `Fråga: """${userText}"""`;
      let out = await callLLM(system, user, 0.5, 700);
      out = normalizeKeys(out);
      out.cards.coverage = 0;
      out.cards.matched_headings = [];
      out.follow_up = out.follow_up || "Vill du att jag kopplar detta till ett specifikt område på linjen?";
      await logInteraction({ userId, question: userText, reply: out, lane: "general", intent: "general_manufacturing", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply: out });
    }

    /* -------- Lane: RAG (definition / operativt) -------- */
    const { context, coverage, matchedHeadings, scores } = await retrieveContext(userText, 8);
    const definitionMode = isDefinitionQuery(userText);

    const system = `
Du är en svensk JARVIS för Linje 65. Operativa råd måste bygga på ManualContext.
- Definitioner/koncept: kort (1–3 meningar), inga påhittade tal.
- Operativa steg/parametrar: endast om täckning är stark.
Returnera strikt JSON enligt schema.`.trim();

    const user = `
ManualContext:
${context || "(tom)"}

Coverage: ${coverage.toFixed(3)}
Fråga:
"""${userText}"""

Instruktioner:
- Fyll matched_headings och coverage (${coverage.toFixed(2)} ±0.05 om motiverat).
- Om definition/”vad gör/är …” och det finns minsta signal (≥1 rubrik eller coverage ≥ 0.35): ge kort förklaring, inga steg.
- För operativa svar: ge steg endast om täckning är stark; annars EN precisering, inga steg/parametrar.
Schema:
{"spoken": string, "need": {"clarify": boolean, "question"?: string}, "cards": {"summary": string, "steps": string[], "explanation": string, "pitfalls": string[], "simple": string, "pro": string, "follow_up": string, "coverage": number, "matched_headings": string[]}, "follow_up": string}`.trim();

    let out = await callLLM(system, user, 0.6, 1600);
    out = normalizeKeys(out);

    if (!out.cards.matched_headings.length) out.cards.matched_headings = matchedHeadings;
    if (typeof out.cards.coverage !== "number" || isNaN(out.cards.coverage)) out.cards.coverage = coverage;

    const operativeOK = passesOperativeGate({ coverage: out.cards.coverage, matchedHeadings: out.cards.matched_headings, scores });
    const defSignalOK = definitionMode && (coverage >= 0.35 || matchedHeadings.length >= 1);

    if (!operativeOK && !defSignalOK) {
      out.need = { clarify: true, question: "Vilket område syftar du på? Ex: 'OCME formatbyte' eller 'Kisters limaggregat'." };
      out.spoken = "Jag saknar underlag i manualen för att svara exakt. Specificera område så guidar jag.";
      out.cards.summary = "Underlaget räcker inte för ett säkert svar.";
      out.cards.steps = [];
      out.cards.explanation = "";
      out.cards.pitfalls = ["Risk för antaganden utan källa."];
      out.cards.simple = "";
      out.cards.pro = "";
      out.cards.follow_up = "Vill du att jag skapar ett utkast till nytt avsnitt? Säg: 'Skapa utkast'.";
      if (process.env.GAP_DRAFTS === "1") {
        try { await createGapDraft({ userId, question: userText, coverage, matchedHeadings, scores }); } catch {}
      }
    }

    if (defSignalOK) {
      out.cards.steps = [];
      out.cards.pitfalls = [];
      out.cards.pro = "";
      out.need = { clarify: false, question: "" };
      out.follow_up = out.follow_up || "Vill du att jag beskriver processen steg för steg?";
    }

    out = sanitizeParameters(out, context);

    const prevWanted = !!(prev && prev.assistant && prev.assistant.need && prev.assistant.need.clarify);
    const isVeryShort = userText.split(/\s+/).filter(Boolean).length <= 3;
    if (out?.need?.clarify && prevWanted && isVeryShort) {
      out.need = { clarify: false, question: "" };
      out.spoken = out.spoken && out.spoken.length > 4 ? out.spoken : "Toppen – då kör vi på det.";
    }

    await logInteraction({
      userId,
      question: userText,
      reply: out,
      lane: defSignalOK ? "definition" : "operative",
      intent: defSignalOK ? "definition" : "operative",
      coverage: out.cards.coverage,
      matchedHeadings: out.cards.matched_headings
    });

    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
