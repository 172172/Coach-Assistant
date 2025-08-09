// /api/chat.js
// Router m. lanes: smalltalk, conv-memory, profile-light, toolbelt (math/units), RAG (definition/operativt)
// + Strict JSON, coverage-gate, param-sanitizer, optional gap-drafts/logging.

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
  return /\b(hej|tja|tjena|hallo|halla|hallå|hur mar du|hur ar laget|allt bra|tack|tackar|vad gor du|vem ar du)\b/.test(t);
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

/* ================= Conversation memory intents ================= */
function parseConversationMemoryIntent(s = "") {
  const t = norm(s);
  if (/\b(forsta fragan|min forsta fraga|vad var min forsta fraga|fragan jag borjade med)\b/.test(t)) {
    return { type: "first" };
  }
  if (/\b(forra fragan|senaste fragan|vad var min forra fraga|vad fragade jag nyss|vad var min senaste fraga)\b/.test(t)) {
    return { type: "last" };
  }
  if (/\b(vad sa du nyss|vad svarade du nyss)\b/.test(t)) {
    return { type: "assistant_last" };
  }
  if (/\b(sammanfatta samtalet|sammanfattning|summering av samtalet|vad har vi pratat om)\b/.test(t)) {
    return { type: "summary" };
  }
  return null;
}

/* ================= Toolbelt: math & units (deterministiskt) ================= */
const MATH_SAFE = /^[\d\s()+\-*/.,%]+$/;

function isMathExpr(s = "") {
  const t = s.replace(/,/g, ".").trim();
  if (!MATH_SAFE.test(t)) return false;
  // måste innehålla minst en operator
  return /[+\-*/%]/.test(t);
}
function evalMath(expr) {
  // enkel % till /100
  let e = expr.replace(/,/g, ".").replace(/(\d+(\.\d+)?)%/g, "($1/100)");
  // paranteskontroll
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
  l: ["l", "liter", "liters", "literre", "litre"],
  ml: ["ml", "milliliter", "millilitrar"],
  dl: ["dl", "deciliter", "decilitrar"],
  cl: ["cl", "centiliter", "centilitrar"],
  mm: ["mm", "millimeter", "millimetrar"],
  cm: ["cm", "centimeter", "centimetrar"],
  m: ["m", "meter", "metrar"]
};
function normUnit(u) {
  const x = norm(u).replace(/\./g, "");
  for (const key of Object.keys(UNIT_ALIASES)) {
    if (UNIT_ALIASES[key].includes(x)) return key;
  }
  return null;
}
function parseUnitConv(s = "") {
  // ex: "3 liter i ml", "3 l till ml", "200 ml -> l", "5 cm i mm"
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
  // längd: mm<->cm<->m
  const lenBase = { mm: 0.001, cm: 0.01, m: 1 };
  // volym: l, dl, cl, ml
  const volBase = { l: 1, dl: 0.1, cl: 0.01, ml: 0.001 };

  if (from in lenBase && to in lenBase) {
    const meters = val * lenBase[from];
    return meters / lenBase[to];
  }
  if (from in volBase && to in volBase) {
    const liters = val * volBase[from];
    return liters / volBase[to];
  }
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
async function callLLM(system, user, temp = 0.6, maxTokens = 1800) {
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

/* ================= Optional logging / gaps ================= */
async function logInteraction({ userId, question, reply, lane, intent, coverage, matchedHeadings }) {
  try {
    if (process.env.LOG_CONVO !== "1") return;
    await q(
      `insert into messages(user_id, asked_at, question, reply_json, smalltalk, is_operational, coverage, matched_headings)
       values ($1, now(), $2, $3::jsonb, $4, $5, $6, $7)`,
      [
        userId,
        question,
        JSON.stringify({ lane: lane || null, intent: intent || null, reply }),
        lane === "smalltalk",
        lane === "operative",
        Number(coverage) || 0,
        matchedHeadings || []
      ]
    );
  } catch (e) { console.warn("logInteraction failed:", e?.message || e); }
}

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
  return out;
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

    /* -------- Lane 1: Spara/Profil-light -------- */
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

    /* -------- Lane 2: Conversation memory -------- */
    const conv = parseConversationMemoryIntent(userText);
    if (conv) {
      const recent = Array.isArray(history) ? history : [];
      let spoken = "Jag har ingen historik i den här sessionen ännu.";
      if (conv.type === "first" && recent.length) {
        const first = recent[0]?.user || "";
        if (first) spoken = `Din första fråga var: “${first}”.`;
      } else if (conv.type === "last" && recent.length) {
        const lastUser = recent[recent.length - 1]?.user || "";
        if (lastUser) spoken = `Din senaste fråga var: “${lastUser}”.`;
      } else if (conv.type === "assistant_last" && recent.length) {
        const lastA = recent[recent.length - 1]?.assistant?.spoken || "";
        if (lastA) spoken = `Jag sa: “${lastA}”.`;
      } else if (conv.type === "summary" && recent.length) {
        const topics = recent.map(x => x.user).filter(Boolean).slice(-6);
        spoken = `Vi har pratat om: ${topics.join(", ")}.`;
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

    /* -------- Lane 3: Smalltalk -------- */
    if (isSmalltalk(userText)) {
      const system = `Du är en svensk JARVIS för Linje 65. Småprat: kort, trevligt, jobb-fokuserat. Returnera strikt JSON enligt schema.`;
      const user = `Småprat: """${userText}"""`;
      let out = await callLLM(system, user, 0.7, 600);
      out = normalizeKeys(out);
      out.cards.coverage = 0; out.cards.matched_headings = [];
      if (!out.spoken) out.spoken = "Jag är din coach för Linje 65. Vad behöver du hjälp med?";
      await logInteraction({ userId, question: userText, reply: out, lane: "smalltalk", intent: "smalltalk", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply: out });
    }

    /* -------- Lane 4: Toolbelt (math & units) -------- */
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

    /* -------- Lane 5: RAG (definition / operativt) -------- */
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
      // Svagt underlag → precisering + ev. gap
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
        await createGapDraft({ userId, question: userText, coverage, matchedHeadings, scores });
      }
    }

    // Definition-läge: rensa steg/parametrar och stäng av clarify
    if (defSignalOK) {
      out.cards.steps = [];
      out.cards.pitfalls = [];
      out.cards.pro = "";
      out.need = { clarify: false, question: "" };
      out.follow_up = out.follow_up || "Vill du att jag beskriver processen steg för steg?";
    }

    // Sanera siffror som inte finns i manualen
    out = sanitizeParameters(out, context);

    // Mindre tjat efter tidigare clarify + kort fråga
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
