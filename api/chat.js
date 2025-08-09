// /api/chat.js
// RAG + Memory + Guards. Bygger svar från manualen när operativt,
// annars från user memory (profil) eller småprat.

import { q } from "./db.js";
import fetch from "node-fetch";
import { getMemory, upsertMemory } from "./memory.js";

// -------- Embedding helpers --------
async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Embeddings API error");
  return j.data[0].embedding;
}
const toPgVector = (arr) => "[" + arr.map((x) => (x ?? 0).toFixed(6)).join(",") + "]";

// -------- Text utils / heuristics --------
const norm = (s = "") =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[åÅ]/g, "a")
    .replace(/[äÄ]/g, "a")
    .replace(/[öÖ]/g, "o");

function isSmalltalk(s = "") {
  const t = norm(s);
  return /\b(hej|tja|tjena|hallo|halla|hallå|hur mar du|hur ar laget|allt bra|tack|tackar|vad gor du|vem ar du)\b/.test(
    t
  );
}

// Profil-intent (fråga)
function isProfileQuery(s = "") {
  const t = norm(s);
  // fånga: "vad heter min linje", "vilken linje jobbar jag på", "min roll", "mitt skift"
  if (/\b(vad|vilken|vad heter|heter)\b.*\b(min|mitt)\b.*\b(linje|line|skift|roll)\b/.test(t)) return true;
  if (/\b(vilken linje jobbar jag pa|min profil|mina uppgifter)\b/.test(t)) return true;
  return false;
}

// Spara-intent (kommando) + enkel parser för "linje 65"
function parseSaveCommand(s = "") {
  const t = norm(s);
  // Ex: "spara linje 65", "kom ihåg min linje linje 65", "remember line 65"
  const save = /\b(spara|kom ihag|kom ihåg|remember)\b/.test(t);
  if (!save) return null;

  // extrahera line_name om det nämns
  // fångar "linje 65", "line 65", eller "linje xx"
  const m =
    t.match(/\b(linje|line)\s*([a-z0-9\-_:]+)\b/i) ||
    t.match(/\b(linje|line)\b.*?\b([a-z0-9\-_:]+)\b/i);

  const line_token = m?.[2] ? m[2].toUpperCase() : null;
  const line_name = line_token ? `Linje ${line_token.replace(/^linje/i, "").trim()}` : null;

  return { intent: "save", line_name };
}

// -------- Retrieve manual context from active doc --------
async function retrieveContext(userText, k = 8) {
  const v = await embed(userText);
  const vec = toPgVector(v);
  const sql = `
    with active as (
      select id from manual_docs where is_active = true order by version desc limit 1
    )
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

// -------- OpenAI chat call --------
async function callLLM(system, user, temp = 0.6, maxTokens = 1800) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: temp,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    console.error("OpenAI chat error:", j);
    throw new Error("Chat API error");
  }
  const content = j.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(content);
  } catch {
    // robust fallback
    return {
      spoken: content || "Okej.",
      need: { clarify: false, question: "" },
      cards: {
        summary: "Samtal",
        steps: [],
        explanation: "",
        pitfalls: [],
        simple: "",
        pro: "",
        follow_up: "",
        coverage: 0,
        matched_headings: [],
      },
      follow_up: "",
    };
  }
}

// -------- (Valfritt) enkel loggning för analys --------
async function logInteraction({ userId, question, reply, smalltalk, isOperational, coverage, matchedHeadings }) {
  try {
    if (process.env.LOG_CONVO !== "1") return;
    await q(
      `insert into messages(user_id, asked_at, question, reply_json, smalltalk, is_operational, coverage, matched_headings)
       values ($1, now(), $2, $3::jsonb, $4, $5, $6, $7)`,
      [userId, question, JSON.stringify(reply || {}), !!smalltalk, !!isOperational, Number(coverage) || 0, matchedHeadings || []]
    );
  } catch (e) {
    console.warn("logInteraction failed:", e?.message || e);
  }
}

// -------- Handler --------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null, history = [], userId: userIdRaw } = req.body || {};
    const userText = String(message || "").trim();

    // userId från body eller header; fallback 'default'
    const userId =
      (typeof userIdRaw === "string" && userIdRaw) ||
      req.headers["x-user-id"] ||
      "default";

    // 0) Tom input
    if (!userText) {
      const reply = {
        spoken: "Jag hörde inget tydligt – säg igen så tar vi det.",
        need: { clarify: true, question: "Kan du säga det igen?" },
        cards: {
          summary: "Otydligt",
          steps: [],
          explanation: "",
          pitfalls: [],
          simple: "",
          pro: "",
          follow_up: "",
          coverage: 0,
          matched_headings: [],
        },
        follow_up: "",
      };
      return res.status(200).json({ reply });
    }

    // A) Save-intent (kommandon som “Spara linje 65”)
    const saveCmd = parseSaveCommand(userText);
    if (saveCmd?.intent === "save") {
      const patch = {};
      if (saveCmd.line_name) patch.line_name = saveCmd.line_name;
      const up = await upsertMemory(userId, patch);
      const saved = up?.row || patch;

      const reply = {
        spoken: saved?.line_name
          ? `Klart. Jag sparade din linje som “${saved.line_name}”.`
          : "Klart. Jag sparade uppgiften.",
        need: { clarify: false, question: "" },
        cards: {
          summary: "Profil uppdaterad.",
          steps: [],
          explanation: "",
          pitfalls: [],
          simple: saved?.line_name ? saved.line_name : "",
          pro: "",
          follow_up: "Vill du spara fler profiluppgifter, t.ex. skift eller roll?",
          coverage: 0,
          matched_headings: [],
        },
        follow_up: "Vill du spara fler profiluppgifter, t.ex. skift eller roll?",
      };

      await logInteraction({
        userId,
        question: userText,
        reply,
        smalltalk: false,
        isOperational: false,
        coverage: 0,
        matchedHeadings: [],
      });

      return res.status(200).json({ reply });
    }

    // B) Smalltalk?
    const smalltalk = isSmalltalk(userText);
    if (smalltalk) {
      // Chatta fritt (ingen RAG, ingen memory).
      const system = `
Du är en AI-assistent för Linje 65 – JARVIS-ton på svenska: varm, kvick men rak.
Småprat/allmänna frågor: svara fritt och trevligt. Returnera strikt JSON enligt schema.
      `.trim();

      const user = `
Detta är småprat. Ignorera manualen. Svara kort och naturligt.
Användarens text:
"""${userText}"""

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
    "coverage": 0,
    "matched_headings": []
  },
  "follow_up": string
}
      `.trim();

      let out = await callLLM(system, user, 0.7, 600);

      // schema sanity
      if (!out || typeof out !== "object") out = {};
      if (!out.need) out.need = { clarify: false, question: "" };
      if (!out.cards) out.cards = {};
      out.cards.coverage = 0;
      out.cards.matched_headings = [];

      await logInteraction({
        userId,
        question: userText,
        reply: out,
        smalltalk: true,
        isOperational: false,
        coverage: 0,
        matchedHeadings: [],
      });

      return res.status(200).json({ reply: out });
    }

    // C) Profilfråga? (t.ex. “Vad heter min linje?”)
    if (isProfileQuery(userText)) {
      const mem = await getMemory(userId);
      if (mem?.line_name) {
        const reply = {
          spoken: `Din linje är ${mem.line_name}.`,
          need: { clarify: false, question: "" },
          cards: {
            summary: `Profiluppgift: ${mem.line_name}.`,
            steps: [],
            explanation: "",
            pitfalls: [],
            simple: mem.line_name,
            pro: "",
            follow_up: "Vill du att jag även minns skift eller roll?",
            coverage: 0,
            matched_headings: [],
          },
          follow_up: "Vill du att jag även minns skift eller roll?",
        };

        await logInteraction({
          userId,
          question: userText,
          reply,
          smalltalk: false,
          isOperational: false,
          coverage: 0,
          matchedHeadings: [],
        });

        return res.status(200).json({ reply });
      } else {
        const reply = {
          spoken:
            "Jag saknar profilinfo om din linje. Vill du att jag sparar den nu? Säg t.ex. “Spara linje 65”.",
          need: { clarify: true, question: "Ska jag spara din linje? Säg: “Spara linje 65”." },
          cards: {
            summary: "Saknar profiluppgift.",
            steps: [],
            explanation: "",
            pitfalls: ["Risk för antaganden utan källa."],
            simple: "",
            pro: "",
            follow_up: "Säg: “Spara linje 65”.",
            coverage: 0,
            matched_headings: [],
          },
          follow_up: "Säg: “Spara linje 65”.",
        };

        await logInteraction({
          userId,
          question: userText,
          reply,
          smalltalk: false,
          isOperational: false,
          coverage: 0,
          matchedHeadings: [],
        });

        return res.status(200).json({ reply });
      }
    }

    // D) Operativt → RAG
    const { context, coverage, matchedHeadings } = await retrieveContext(userText, 8);

    const system = `
Du är en AI-assistent för Linje 65 – JARVIS-ton på svenska: varm och pedagogisk, men faktabunden.
Regler:
- Operativa råd (procedurer, säkerhet, kvalitet, felsökning, parametrar) måste bygga på "ManualContext".
- Hitta inte på siffror/parametrar som inte står i manualen.
- Om underlaget är otydligt: ge ett säkert, försiktigt svar och ställ EN konkret följdfråga.
- Returnera STRIKT JSON enligt schema.
    `.trim();

    const user = `
ManualContext (ur aktiv manual):
${context || "(tom)"}

Täckningsindikator (0..1, heuristik): ${coverage.toFixed(3)}
Tidigare tur: ${prev ? JSON.stringify(prev) : "null"}
Historik (kort): ${history && history.length ? JSON.stringify(history.slice(-6)) : "[]"}

Användarens fråga:
"""${userText}"""

Instruktioner:
- Bygg svaret från ManualContext. Sätt "matched_headings" till relevanta rubriker.
- Sätt "coverage" till ${coverage.toFixed(2)} (du kan justera ±0.05 om motiverat).
- Om ManualContext är för svag (t.ex. coverage < 0.5 eller 0 rubriker):
  * Ge inga exakta steg/parametrar.
  * Ställ EN precisering.
  * Inga extra fakta eller “dekorering” utanför ManualContext.
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

    // -------- Schema sanity + injektion av kända fält --------
    if (!out || typeof out !== "object")
      out = {
        spoken: "Okej.",
        need: { clarify: false, question: "" },
        cards: {
          summary: "",
          steps: [],
          explanation: "",
          pitfalls: [],
          simple: "",
          pro: "",
          follow_up: "",
          coverage: 0,
          matched_headings: [],
        },
        follow_up: "",
      };
    if (!out.need) out.need = { clarify: false, question: "" };
    if (!out.cards)
      out.cards = {
        summary: "",
        steps: [],
        explanation: "",
        pitfalls: [],
        simple: "",
        pro: "",
        follow_up: "",
        coverage: 0,
        matched_headings: [],
      };
    if (!Array.isArray(out.cards.steps)) out.cards.steps = [];
    if (!Array.isArray(out.cards.matched_headings) || out.cards.matched_headings.length === 0)
      out.cards.matched_headings = matchedHeadings;
    if (typeof out.cards.coverage !== "number" || isNaN(out.cards.coverage))
      out.cards.coverage = coverage;

    // -------- Zero-coverage guard (stoppa “dekorering”) --------
    const isOperational = true;
    const weakContext = matchedHeadings.length === 0 || coverage < 0.5;
    if (isOperational && weakContext) {
      out.need = { clarify: true, question: "Vilket område syftar du på? Ex: 'OCME formatbyte' eller 'Kisters limaggregat'." };
      out.spoken = "Jag saknar underlag i manualen för att svara exakt. Specificera område så guidar jag.";
      out.cards = {
        summary: "Underlaget räcker inte för ett säkert svar.",
        steps: [],
        explanation: "",
        pitfalls: ["Risk för antaganden utan källa."],
        simple: "",
        pro: "",
        follow_up: "Säg t.ex. 'OCME formatbyte höjd' eller 'Tapp fals problem'.",
        coverage,
        matched_headings,
      };
    }

    // -------- Mildra tjat om du redan bett om precisering i förra turen --------
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
      smalltalk: false,
      isOperational: true,
      coverage: out.cards.coverage,
      matchedHeadings: out.cards.matched_headings,
    });

    return res.status(200).json({ reply: out });
  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
