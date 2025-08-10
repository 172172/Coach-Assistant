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

  // GROK: Ny intent för switch topic / off-topic
  if (/\b(vanta|glöm det|istället|byt ämne|ny fråga|hoppa över)\b/.test(t)) return { type: "switch_topic" };

  // GROK: Auto-detect för missförstånd
  if (/\b(vad\?|förstår inte|vänta vad|hur menar du|huh)\b/.test(t)) return { type: "clarify_last" };

  return null;
}

async function rewriteFromLast(userText, history, userId) {
  // GROK: Ändrat för att inkludera senaste user-frågan också för bättre kontext
  let lastAssistant = lastAssistantSpoken(history || []);
  let lastUser = lastUserQuestion(history || []);
  if (!lastAssistant || !lastUser) {
    const dbHist = await getRecentHistoryFromDB(userId, 50);
    lastAssistant = lastAssistantSpoken(dbHist);
    lastUser = lastUserQuestion(dbHist);
  }
  return { lastUser, lastAssistant: String(lastAssistant || "") };
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
  cl: ["cl","centiliter","centimetrar"],
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
/* ================= Status / News lane ================= */

// Träffar frågor som: "vad har hänt idag/igår/denna vecka", "status", "nyheter", "överlämning", "underhåll"
function isStatusQuery(s = "") {
  const t = norm(s);
  const statusWords = /(vad har hant|vad har hänt|status|laget|läget|uppdatering|nyheter|overlamning|överlämning|underhall|underhåll)/;
  const timeHints   = /(idag|just nu|igar|igår|denna vecka|i veckan|veckan|forra veckan|förra veckan)/;
  return statusWords.test(t) || (/(vad har)/.test(t) && timeHints.test(t));
}


// Light daterange-parser → 'today' | 'yesterday' | 'last_week' | 'week'
function parseStatusRange(s = "") {
  const t = norm(s);
  if (/\bidag|just nu|idag\b/.test(t)) return { key: "today", label: "idag" };
  if (/\bigar|igår\b/.test(t)) return { key: "yesterday", label: "igår" };
  if (/\bforra veckan|förra veckan\b/.test(t)) return { key: "last_week", label: "förra veckan" };
  if (/\bdenna vecka|i veckan|veckan\b/.test(t)) return { key: "week", label: "denna vecka" };
  return { key: "week", label: "senaste veckan" };
}

// Hämta endast line_news för intervallet
async function fetchStatusData(rangeKey = "week") {
  let whereNews = "news_at >= now() - interval '7 days'";
  if (rangeKey === "today") {
    whereNews = "news_at >= date_trunc('day', now())";
  } else if (rangeKey === "yesterday") {
    whereNews = "news_at >= date_trunc('day', now()) - interval '1 day' AND news_at < date_trunc('day', now())";
  } else if (rangeKey === "last_week") {
    whereNews = "news_at >= date_trunc('week', now()) - interval '1 week' AND news_at < date_trunc('week', now())";
  }

  const newsSql = `
    select id, news_at, section, area, shift, title, body, tags
    from line_news
    where ${whereNews}
    order by news_at desc
    limit 300
  `;

  const n = await q(newsSql);
  return { news: n?.rows || [] };
}

// Bygg mer utförlig sammanfattning via callLLM
async function buildStatusReply({ news = [], label = "senaste veckan", history = [] }) {
  if (!news || news.length === 0) {
    const empty = {
      spoken: `Lugnt läge ${label} – inget särskilt att rapportera! Ibland är det skönt när allt bara rullar på. 😊`,
      need: { clarify: false, question: "" },
      cards: { summary: `Inget registrerat ${label}.`, steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
      follow_up: "Vill du att vi börjar logga vad som händer?"
    };
    return normalizeKeys(empty);
  }

  // Förbättrad datumformatering med rätt veckodag
  const fmt = (d) => {
    const date = new Date(d);
    const weekdays = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
    const weekday = weekdays[date.getDay()];
    const dateStr = date.toLocaleDateString("sv-SE", { month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString("sv-SE", { hour: '2-digit', minute: '2-digit' });
    return `${weekday} ${dateStr} kl ${timeStr}`;
  };
  
  // Förbered data för LLM med bättre struktur
  const newsData = news.map(n => ({
    when: fmt(n.news_at),
    area: n.area || n.section || "Okänt område",
    shift: n.shift || "",
    title: n.title || "",
    body: n.body || "",
    tags: Array.isArray(n.tags) ? n.tags : []
  }));

  // Uppdatering: Uppdaterad system-prompt för mer Grok-lik ton – humoristisk, vardaglig med slang och variation
  const system = `
Du är Grok-lik: en smart, humoristisk AI byggd av xAI, som snackar som en svensk polare på fabriksgolvet. Använd vardagsspråk, slang ('du vet', 'typ', 'eh'), lite sarkasm eller skämt ibland. Variera: ibland kort, ibland längre för att kännas mänsklig.
Berätta om vad som hänt ${label} som en kollega som överlämnar till nästa skift – levande, engagerande, med 'vi' och konkreta detaljer.

VIKTIGT:
- Använd EXAKTA veckodagar från datumen - inte påhittade dagar
- När du nämner "tisdag" eller liknande, kontrollera att det stämmer med när-fältet

INNEHÅLL:
- Börja med en övergripande känsla/läge
- Gå sedan in på specifika händelser per område
- Nämn alltid VILKET område/skift det gällde
- Inkludera tekniska detaljer som är relevanta
- Prioritera allt som påverkar drift/produktion/kvalitet

STRUKTUR:
- spoken: 4-8 meningar som berättar vad som FAKTISKT hänt med konkreta detaljer
- steps: Alla viktiga händelser som punkter: "OMRÅDE (SKIFT): Detaljerad beskrivning"

Returnera JSON, men låt 'spoken' flyta naturligt.
`;

  // Anropa LLM med högre temperature för variation
  let out = await callLLM(system, JSON.stringify(newsData), 0.9, 1200, history);  // Uppdaterat: Högre temp för mer kreativ, mänsklig ton
  out = normalizeKeys(out);
  return out;
}

/* ================= Helpers for history etc. ================= */
// Assuming these are defined somewhere; based on truncation, adding placeholders
function lastAssistantSpoken(history) {
  // Logic to get last assistant spoken from history
  return history.filter(h => h.role === 'assistant').pop()?.spoken || '';
}

function lastUserQuestion(history) {
  // Logic to get last user question from history
  return history.filter(h => h.role === 'user').pop()?.content || '';
}

async function getRecentHistoryFromDB(userId, limit) {
  // Placeholder for DB query
  return []; // Replace with actual query
}

function normalizeKeys(obj) {
  // Normalize JSON keys to lowercase or standard
  const newObj = {};
  for (const key in obj) {
    newObj[key.toLowerCase()] = obj[key];
  }
  return newObj;
}

function sortByTsIfAny(history) {
  // Sort history by timestamp if available
  return history.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

async function logInteraction({ userId, question, reply, lane, intent, coverage, matchedHeadings }) {
  // Placeholder for logging
  console.log('Logging interaction:', { userId, question, lane, intent });
}

async function retrieveContext(userText, topK, userId) {
  // Placeholder for RAG context retrieval
  return { context: '', coverage: 0, matchedHeadings: [], scores: [] };
}

function passesOperativeGate({ coverage, matchedHeadings, scores }) {
  // Placeholder gate logic
  return coverage > 0.5;
}

function sanitizeParameters(out, context) {
  // Placeholder sanitization
  return out;
}

async function createGapDraft({ userId, question, coverage, matchedHeadings, scores }) {
  // Placeholder for gap draft
}

// Assuming callLLM is defined
async function callLLM(system, user, temp, maxTokens, history) {
  // Placeholder for LLM call
  return { spoken: 'Placeholder response', cards: { coverage: 0, matched_headings: [] } }; // Replace with actual API call
}

export default async function handler(req, res) {
  try {
    const { userText, userId, history, prev } = req.body || {};
    if (!userText || typeof userText !== "string" || !userId) {
      return res.status(400).json({ error: "Saknar userText eller userId" });
    }

    /* -------- Lane: Identity -------- */
    if (isIdentityQuery(userText)) {
      const spoken = "Jag är din AI-kompis på golvet – byggd av xAI som Grok, men anpassad för linjen. Typ en smart kollega som hjälper till med frågor, minne och råd. Vad kör vi på? 😎";
      const reply = normalizeKeys({
        spoken,
        need: { clarify: false, question: "" },
        cards: { summary: "Vem är jag?", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
        follow_up: ""
      });
      await logInteraction({ userId, question: userText, reply, lane: "identity", intent: "identity", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply });
    }

    /* -------- Lane: Profile / Save -------- */
    const save = parseSaveCommand(userText);
    if (save) {
      await upsertMemory(userId, "line_name", save.line_name);
      const spoken = `Sparat! Du jobbar på ${save.line_name}. Bra att veta för framtida snack. 👍`;
      const reply = normalizeKeys({
        spoken,
        need: { clarify: false, question: "" },
        cards: { summary: "Profil uppdaterad.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
        follow_up: ""
      });
      await logInteraction({ userId, question: userText, reply, lane: "profile", intent: "save", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply });
    }
    if (isProfileQuery(userText)) {
      const mem = await getMemory(userId, "line_name");
      const line = mem?.line_name || "ingen linje sparad än";
      const spoken = `Du jobbar på ${line}. Vill du ändra? Säg 'Spara linje X'.`;
      const reply = normalizeKeys({
        spoken,
        need: { clarify: false, question: "" },
        cards: { summary: "Din profil.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
        follow_up: ""
      });
      await logInteraction({ userId, question: userText, reply, lane: "profile", intent: "query", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply });
    }

    /* -------- Lane: Conversation memory -------- */
    const conv = parseConversationMemoryIntent(userText);
    if (conv) {
      const sourceHistory = history || [];
      let spoken = "";
      if (sourceHistory.length < 2) {
        const dbHist = await getRecentHistoryFromDB(userId, 50);
        sourceHistory.push(...dbHist);
      }
      if (conv.type === "first") {
        const first = sourceHistory[0]?.user || "";
        if (first) spoken = `Din första fråga var: “${first}”. Vad sägs om att bygga på det?`;
      } else if (conv.type === "last" || conv.type === "last_user") {
        const last = lastUserQuestion(sourceHistory);
        if (last) spoken = (conv.type === "last_user") ? `Du sa: “${last}”.` : `Din senaste fråga var: “${last}”. Fattar du vad jag menar?`;
      } else if (conv.type === "assistant_last") {
        const lastA = lastAssistantSpoken(sourceHistory);
        spoken = lastA ? `Jag sa: “${lastA}”. Ska jag bryta ner det mer?` : "Jag har inget tidigare svar att upprepa ännu.";
      } else if (conv.type === "summary") {
        const entries = sortByTsIfAny(sourceHistory).map(h => h?.user).filter(Boolean).slice(-6);
        spoken = entries.length ? `Vi har snackat om: ${entries.join(", ")}. Vad kör vi vidare på?` : "Vi har inte pratat om något än.";
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
      // Hämta källsvar (senaste assistent + user)
      const base = await rewriteFromLast(userText, history, userId);
      if (!base.lastAssistant) {
        const fallback = normalizeKeys({
          spoken: "Jag har inget tidigare svar att jobba vidare på ännu. Vad menar du? 😊",
          need: { clarify: false, question: "" },
          cards: { summary: "Ingen historik hittad.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        });
        await logInteraction({ userId, question: userText, reply: fallback, lane: "rewrite", intent: rw.type, coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply: fallback });
      }

      if (rw.type === "pace_slow" || rw.type === "pace_fast") {
        const reply = normalizeKeys({
          spoken: rw.type === "pace_slow" ? "Okej, jag tar det lugnare nu. 👍" : "Absolut, jag gasar på lite!",
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
          spoken: base.lastAssistant,
          need: { clarify: false, question: "" },
          cards: { summary: "Upprepning av senaste svar.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        });
        await logInteraction({ userId, question: userText, reply, lane: "rewrite", intent: "repeat", coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      }

      if (rw.type === "switch_topic") {
        const reply = normalizeKeys({
          spoken: "Okej, vi byter spår! Vad vill du snacka om istället?",
          need: { clarify: true, question: "Vad är din nya fråga?" },
          cards: { summary: "Ämnesbyte.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        });
        await logInteraction({ userId, question: userText, reply, lane: "rewrite", intent: "switch_topic", coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      }

      if (rw.type === "clarify_last") {
        const reply = normalizeKeys({
          spoken: `Du frågade om “${base.lastUser}” och jag sa “${base.lastAssistant}”. Fattar du nu, eller ska jag förklara annorlunda?`,
          need: { clarify: false, question: "" },
          cards: { summary: "Förtydligande.", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        });
        await logInteraction({ userId, question: userText, reply, lane: "rewrite", intent: "clarify_last", coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      }

      // Uppdatering: Uppdaterad system-prompt för Grok-lik ton i rewrite
      const system = `Du är Grok-lik: en smart, humoristisk AI byggd av xAI, som snackar som en svensk polare på fabriksgolvet. Använd vardagsspråk, slang ('du vet', 'typ', 'eh'), lite sarkasm eller skämt ibland. Variera: ibland kort, ibland längre för att kännas mänsklig. Omskriv senaste svar personligt och varierat, som om du pratar med en kompis. Returnera JSON, men låt 'spoken' flyta naturligt.`; 
      const user = JSON.stringify({
        intent: rw.type,
        base: base.lastAssistant,
        previous_question: base.lastUser
      });
      let out = await callLLM(system, user, 0.9, 800, history);  // Uppdaterat: Högre temp för variation
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
      // Uppdatering: Uppdaterad prompt för Grok-lik ton
      const system = `Du är Grok-lik: en smart, humoristisk AI byggd av xAI, som snackar som en svensk polare på fabriksgolvet. Använd vardagsspråk, slang ('du vet', 'typ', 'eh'), lite sarkasm eller skämt ibland. Variera: ibland kort, ibland längre för att kännas mänsklig. Returnera JSON, men låt 'spoken' flyta naturligt.`; 
      const user = `Småprat: """${userText}"""`;
      let out = await callLLM(system, user, 0.9, 600, history);  // Uppdaterat: Högre temp
      out = normalizeKeys(out);
      out.cards.coverage = 0; out.cards.matched_headings = [];
      if (!out.spoken) out.spoken = "Allt lugnt här – på tårna. Vad kör vi på idag? 😊";
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
          spoken: `${unitReq.val} ${unitReq.from} är ${rounded} ${unitReq.to}. Schysst, eller hur?`,
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
          spoken: `Det blir ${rounded}. Fattar du hur jag räknade?`,
          need: { clarify: false, question: "" },
          cards: { summary: "Beräkning", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] },
          follow_up: ""
        });
        await logInteraction({ userId, question: userText, reply, lane: "toolbelt", intent: "math", coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      } catch {}
    }

    /* -------- Lane: Status / Nyheter / Överlämning -------- */
    if (isStatusQuery(userText)) {
      const range = parseStatusRange(userText); // { key, label }
      const { news } = await fetchStatusData(range.key);
      const reply = await buildStatusReply({ news, label: range.label, history });

      await logInteraction({
        userId,
        question: userText,
        reply,
        lane: "status",
        intent: `status_${range.key}`,
        coverage: 0,
        matchedHeadings: ["line_news"]
      });

      return res.status(200).json({ reply });
    }

    /* -------- Lane: General knowledge (jobbrelaterat, ej parametrar) -------- */
    if (isGeneralManufacturingQuery(userText)) {
      // Uppdatering: Uppdaterad prompt för Grok-lik ton
      const system = `
Du är Grok-lik: en smart, humoristisk AI byggd av xAI, som snackar som en svensk polare på fabriksgolvet. Använd vardagsspråk, slang ('du vet', 'typ', 'eh'), lite sarkasm eller skämt ibland. Variera: ibland kort, ibland längre för att kännas mänsklig.
Svara på allmänna produktionsfrågor (Lean/OEE etc.) med principer och enkla exempel, som en kollega – inte som en robot. Hänvisa till manualen om det blir för specifikt.
Returnera JSON, men låt 'spoken' flyta naturligt.
`; 
      const user = `Fråga: """${userText}"""`;
      let out = await callLLM(system, user, 0.8, 700, history);  // Uppdaterat: Högre temp
      out = normalizeKeys(out);
      out.cards.coverage = 0;
      out.cards.matched_headings = [];
      out.follow_up = out.follow_up || "Vill du att jag kopplar detta till ett specifikt område på linjen? 😊";
      await logInteraction({ userId, question: userText, reply: out, lane: "general", intent: "general_manufacturing", coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply: out });
    }

    /* -------- Lane: RAG (definition / operativt) -------- */
    const { context, coverage, matchedHeadings, scores } = await retrieveContext(userText, 8, userId);
    const definitionMode = isDefinitionQuery(userText);

    // Uppdatering: Uppdaterad system-prompt för Grok-lik ton
    const system = `
Du är Grok-lik: en smart, humoristisk AI byggd av xAI, som snackar som en svensk polare på fabriksgolvet. Använd vardagsspråk, slang ('du vet', 'typ', 'eh'), lite sarkasm eller skämt ibland. Variera: ibland kort, ibland längre för att kännas mänsklig.
Operativa råd från ManualContext – ge råd som en erfaren operatör.
- Definitioner: kort, inga påhitt.
- Steg: endast vid stark täckning.
Returnera JSON, men låt 'spoken' flyta naturligt.
`;

    const user = `
ManualContext:
${context || "(tom)"}

Coverage: ${coverage.toFixed(3)}
Fråga:
"""${userText}"""

Instruktioner:
- Fyll matched_headings och coverage (${coverage.toFixed(2)} ±0.05 om motiverat).
- Om definition och signal OK: kort förklaring.
- För operativa: steg bara vid stark täckning; annars precisera.
- Vid låg coverage: föreslå allmän kunskap som fallback.
Schema:
{"spoken": string, "need": {"clarify": boolean, "question"?: string}, "cards": {"summary": string, "steps": string[], "explanation": string, "pitfalls": string[], "simple": string, "pro": string, "follow_up": string, "coverage": number, "matched_headings": string[]}, "follow_up": string}`.trim();

    let out = await callLLM(system, user, 0.8, 1600, history);  // Uppdaterat: Högre temp
    out = normalizeKeys(out);

    if (!out.cards.matched_headings.length) out.cards.matched_headings = matchedHeadings;
    if (typeof out.cards.coverage !== "number" || isNaN(out.cards.coverage)) out.cards.coverage = coverage;

    const operativeOK = passesOperativeGate({ coverage: out.cards.coverage, matchedHeadings: out.cards.matched_headings, scores });
    const defSignalOK = definitionMode && (coverage >= 0.35 || matchedHeadings.length >= 1);

    if (!operativeOK && !defSignalOK) {
      if (isGeneralManufacturingQuery(userText)) {
        out.spoken = "Jag har inte exakt från manualen, men generellt... " + (out.spoken || "Låt mig förklara principen.");
      } else {
        out.need = { clarify: true, question: "Vilket område syftar du på? Ex: 'OCME formatbyte'." };
        out.spoken = "Saknar underlag i manualen för exakt svar. Specificera så guidar jag! 😊";
        out.cards.summary = "Underlaget räcker inte.";
        out.cards.steps = [];
        out.cards.explanation = "";
        out.cards.pitfalls = ["Risk för antaganden."];
        out.cards.simple = "";
        out.cards.pro = "";
        out.cards.follow_up = "Skapa utkast? Säg 'Skapa utkast'.";
      }
      if (process.env.GAP_DRAFTS === "1") {
        try { await createGapDraft({ userId, question: userText, coverage, matchedHeadings, scores }); } catch {}
      }
    }

    if (defSignalOK) {
      out.cards.steps = [];
      out.cards.pitfalls = [];
      out.cards.pro = "";
      out.need = { clarify: false, question: "" };
      out.follow_up = out.follow_up || "Vill du ha processen steg för steg?";
    }

    out = sanitizeParameters(out, context);

    const prevWanted = !!(prev && prev.assistant && prev.assistant.need && prev.assistant.need.clarify);
    const isVeryShort = userText.split(/\s+/).filter(Boolean).length <= 3;
    if (out?.need?.clarify && prevWanted && isVeryShort) {
      out.need = { clarify: false, question: "" };
      out.spoken = out.spoken && out.spoken.length > 4 ? out.spoken : "Toppen – då kör vi på det. 👍";
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

  } catch (e) {
    console.error("chat.js error:", e);
    res.status(500).json({ error: "Serverfel i chat.js", details: e?.message || String(e) });
  }
}
