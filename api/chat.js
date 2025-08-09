// /api/chat.js
// RAG + Memory + Guards + Gap Drafts

import { q } from "./db.js";
import fetch from "node-fetch";
import { getMemory, upsertMemory } from "./memory.js";

// -------- Embedding helpers --------
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
const toPgVector = (arr) => "[" + arr.map((x) => (x ?? 0).toFixed(6)).join(",") + "]";

// -------- Text utils / heuristics --------
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

// -------- Retrieve manual context --------
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
  const scores = rows.map((x) => Number(x.score) || 0);
  const base = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const headingBonus = Math.min(0.1, (new Set(rows.map((r) => r.heading)).size - 1) * 0.025);
  const coverage = Math.max(0, Math.min(1, base + headingBonus));

  const context = rows.map((x) => `### ${x.heading}\n${x.chunk}`).join("\n\n---\n\n");
  const matchedHeadings = [...new Set(rows.map((x) => x.heading))].slice(0, 6);
  return { context, coverage, matchedHeadings, scores };
}

// -------- OpenAI calls --------
async function callLLM(system, user, temp = 0.6, maxTokens = 1800) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4o", temperature: temp, max_tokens: maxTokens, messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ] })
  });
  const j = await r.json();
  if (!r.ok) { console.error("OpenAI chat error:", j); throw new Error("Chat API error"); }
  const content = j.choices?.[0]?.message?.content || "";
  try { return JSON.parse(content); }
  catch {
    return { spoken: content || "Okej.", need: { clarify: false, question: "" }, cards: {
      summary: "Samtal", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: []
    }, follow_up: "" };
  }
}

// -------- (Valfritt) logg till messages --------
async function logInteraction({ userId, question, reply, smalltalk, isOperational, coverage, matchedHeadings }) {
  try {
    if (process.env.LOG_CONVO !== "1") return;
    await q(
      `insert into messages(user_id, asked_at, question, reply_json, smalltalk, is_operational, coverage, matched_headings)
       values ($1, now(), $2, $3::jsonb, $4, $5, $6, $7)`,
      [userId, question, JSON.stringify(reply || {}), !!smalltalk, !!isOperational, Number(coverage) || 0, matchedHeadings || []]
    );
  } catch (e) { console.warn("logInteraction failed:", e?.message || e); }
}

// -------- GAP DRAFTS: skapa ett utkast när coverage är låg --------
async function createGapDraft({ userId, question, coverage, matchedHeadings, scores }) {
  try {
    if (process.env.GAP_DRAFTS !== "1") return null;

    const system = `
Du skapar ett UTKAST (inte slutligt svar) när manualen saknar täckning.
Regler:
- Skriv neutral, faktabaserad struktur för hur ett avsnitt i manualen BORDE se ut.
- INGA exakta tal, tider, tryck, mm om de inte givits. Använd "[PLATS FÖR VÄRDE]" som platshållare.
- Föreslå rubrik + kort sammanfattning + kort markdown med struktur (3–8 punkter/steg).
- Detta är material för mänsklig granskning innan publicering.
Returnera strikt JSON:
{
  "title": string,
  "heading": string,
  "summary": string,
  "outline": string[],         // 3–8 punkter
  "md": string                  // kort markdown-utkast med platshållare
}
    `.trim();

    const user = `
Fråga: "${question}"
Matchade rubriker: ${JSON.stringify(matchedHeadings || [])}
Coverage (0..1): ${coverage.toFixed(3)}
Skapa ett kort, nytt avsnitt som täcker luckan enligt reglerna.
    `.trim();

    const draft = await callLLM(system, user, 0.2, 700);

    const sql = `
      insert into kb_gaps(status, user_id, question, intent, coverage, matched_headings, scores,
                          gap_reason, draft_title, draft_heading, draft_md, draft_outline, priority, created_by_ai)
      values ('open', $1, $2, 'operational', $3, $4, $5,
              'låg täckning i manualen', $6, $7, $8, $9::jsonb, 0, true)
      returning id
    `;
    const r = await q(sql, [
      userId,
      question,
      coverage,
      matchedHeadings || [],
      scores || [],
      draft?.title || null,
      draft?.heading || null,
      draft?.md || null,
      JSON.stringify(draft?.outline || [])
    ]);
    return r?.rows?.[0]?.id || null;
  } catch (e) {
    console.warn("createGapDraft failed:", e?.message || e);
    return null;
  }
}

// -------- Handler --------
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

    // Save-intent (t.ex. "Spara linje 65")
    const saveCmd = parseSaveCommand(userText);
    if (saveCmd?.intent === "save") {
      const patch = {};
      if (saveCmd.line_name) patch.line_name = saveCmd.line_name;
      const up = await upsertMemory(userId, patch);
      const saved = up?.row || patch;
      const reply = {
        spoken: saved?.line_name ? `Klart. Jag sparade din linje som “${saved.line_name}”.` : "Klart. Jag sparade uppgiften.",
        need: { clarify: false, question: "" },
        cards: { summary: "Profil uppdaterad.", steps: [], explanation: "", pitfalls: [], simple: saved?.line_name || "", pro: "", follow_up: "Vill du lägga in fler uppgifter?", coverage: 0, matched_headings: [] },
        follow_up: "Vill du lägga in fler uppgifter?"
      };
      await logInteraction({ userId, question: userText, reply, smalltalk: false, isOperational: false, coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply });
    }

    // Smalltalk
    if (isSmalltalk(userText)) {
      const system = `Du är en svensk JARVIS. Småprat: kort, trevligt. Returnera strikt JSON enligt schema.`;
      const user = `Småprat (ingen manual). Text: """${userText}"""`;
      let out = await callLLM(system, user, 0.7, 600);
      if (!out || typeof out !== "object") out = {};
      if (!out.need) out.need = { clarify: false, question: "" };
      if (!out.cards) out.cards = {};
      out.cards.coverage = 0; out.cards.matched_headings = [];
      await logInteraction({ userId, question: userText, reply: out, smalltalk: true, isOperational: false, coverage: 0, matchedHeadings: [] });
      return res.status(200).json({ reply: out });
    }

    // Profilfråga
    if (isProfileQuery(userText)) {
      const mem = await getMemory(userId);
      if (mem?.line_name) {
        const reply = {
          spoken: `Din linje är ${mem.line_name}.`,
          need: { clarify: false, question: "" },
          cards: { summary: `Profiluppgift: ${mem.line_name}.`, steps: [], explanation: "", pitfalls: [], simple: mem.line_name, pro: "", follow_up: "Vill du att jag minns något mer?", coverage: 0, matched_headings: [] },
          follow_up: "Vill du att jag minns något mer?"
        };
        await logInteraction({ userId, question: userText, reply, smalltalk: false, isOperational: false, coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      } else {
        const reply = {
          spoken: "Jag saknar profilinfo om din linje. Säg till om jag ska spara den. Ex: “Spara linje 65”.",
          need: { clarify: true, question: "Ska jag spara din linje? Säg: “Spara linje 65”." },
          cards: { summary: "Saknar profiluppgift.", steps: [], explanation: "", pitfalls: ["Risk för antaganden utan källa."], simple: "", pro: "", follow_up: "Säg: “Spara linje 65”.", coverage: 0, matched_headings: [] },
          follow_up: "Säg: “Spara linje 65”."
        };
        await logInteraction({ userId, question: userText, reply, smalltalk: false, isOperational: false, coverage: 0, matchedHeadings: [] });
        return res.status(200).json({ reply });
      }
    }

    // Operativt → RAG
    const { context, coverage, matchedHeadings, scores } = await retrieveContext(userText, 8);

    const system = `
Du är en svensk JARVIS för Linje 65. Operativa råd måste bygga på ManualContext.
Inga påhittade parametervärden. Vid svagt underlag: ge säkert, försiktigt svar + EN precisering.
Returnera strikt JSON enligt schema.
    `.trim();

    const user = `
ManualContext:
${context || "(tom)"}

Coverage: ${coverage.toFixed(3)}
Historik kort: ${history && history.length ? JSON.stringify(history.slice(-6)) : "[]"}

Fråga:
"""${userText}"""

Instruktioner:
- Bygg svaret från ManualContext. Fyll matched_headings.
- Sätt coverage till ${coverage.toFixed(2)} (±0.05 om motiverat).
- Om coverage < 0.5 ELLER 0 rubriker:
  * Inga exakta steg/parametrar.
  * Ställ EN precisering.
  * Ingen dekorering utanför ManualContext.
Schema:
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

    let out = await callLLM(system, user, 0.6, 1800);

    // Schema sanity + injektion
    if (!out || typeof out !== "object")
      out = { spoken: "Okej.", need: { clarify: false, question: "" }, cards: { summary: "", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] }, follow_up: "" };
    if (!out.need) out.need = { clarify: false, question: "" };
    if (!out.cards) out.cards = { summary: "", steps: [], explanation: "", pitfalls: [], simple: "", pro: "", follow_up: "", coverage: 0, matched_headings: [] };
    if (!Array.isArray(out.cards.steps)) out.cards.steps = [];
    if (!Array.isArray(out.cards.matched_headings) || out.cards.matched_headings.length === 0) out.cards.matched_headings = matchedHeadings;
    if (typeof out.cards.coverage !== "number" || isNaN(out.cards.coverage)) out.cards.coverage = coverage;

    // Zero-coverage guard + erbjud utkast
    const weakContext = matchedHeadings.length === 0 || coverage < 0.5;
    if (weakContext) {
      out.need = { clarify: true, question: "Vilket område syftar du på? Ex: 'OCME formatbyte' eller 'Kisters limaggregat'." };
      out.spoken = "Jag saknar underlag i manualen för att svara exakt. Specificera område så guidar jag.";
      out.cards = {
        summary: "Underlaget räcker inte för ett säkert svar.",
        steps: [],
        explanation: "",
        pitfalls: ["Risk för antaganden utan källa."],
        simple: "",
        pro: "",
        follow_up: "Vill du att jag skapar ett utkast till nytt avsnitt? Säg: 'Skapa utkast'.",
        coverage,
        matched_headings
      };
      // Skapa utkast i bakgrunden (flagga via env)
      await createGapDraft({ userId, question: userText, coverage, matchedHeadings, scores });
    }

    // Mildra tjat efter tidigare clarify
    const prevWanted = !!(prev && prev.assistant && prev.assistant.need && prev.assistant.need.clarify);
    const isVeryShort = userText.split(/\s+/).filter(Boolean).length <= 3;
    if (out?.need?.clarify && prevWanted && isVeryShort) {
      out.need = { clarify: false, question: "" };
      out.spoken = out.spoken && out.spoken.length > 4 ? out.spoken : "Toppen – då kör vi på det.";
    }

    await logInteraction({ userId, question: userText, reply: out, smalltalk: false, isOperational: true, coverage: out.cards.coverage, matchedHeadings: out.cards.matched_headings });
    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
