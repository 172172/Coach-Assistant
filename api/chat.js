// /api/chat.js
// RAG mot Supabase: hämtar relevanta manual-chunkar via pgvector och bygger svar utifrån dem.

import { q } from "./db.js";
import fetch from "node-fetch";

// --- Embedding helpers ---
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

// --- Smalltalk-heuristik (enkel) ---
const norm = (s="") => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
function isSmalltalk(s="") {
  const t = norm(s);
  return /\b(hej|tja|tjena|hallo|hallå|hur mår du|hur ar laget|allt bra|tack|tackar|vad gor du|vem ar du)\b/.test(t);
}

// --- Hämta topp-chunkar från aktiv manual ---
async function retrieveContext(userText, k = 8) {
  const v = await embed(userText);
  const vec = toPgVector(v);
  // rankera närmsta chunkar från aktiv manual (lägsta <=> = närmast)
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
  // beräkna "coverage" som normaliserad medelscore (0..1)
  const cov = rows.length
    ? Math.max(0, Math.min(1, rows.map(x => Number(x.score)||0).reduce((a,b)=>a+b,0) / rows.length))
    : 0;

  const context = rows.map((x,i) => `### ${x.heading}\n${x.chunk}`).join("\n\n---\n\n");
  const matchedHeadings = [...new Set(rows.map(x => x.heading))].slice(0, 6);
  return { context, coverage: cov, matchedHeadings };
}

// --- OpenAI call (samma JSON-schema som index.html förväntar) ---
async function callLLM(system, user, temp = 0.6, maxTokens = 1800) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: temp,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
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
      need: { clarify: false },
      cards: {
        summary: "Samtal",
        steps: [], explanation: "", pitfalls: [],
        simple: "", pro: "", follow_up: "",
        coverage: 0, matched_headings: []
      },
      follow_up: ""
    };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null, history = [] } = req.body || {};
    const userText = String(message || "").trim();

    // 1) Småprat: svara fritt utan manual
    if (!userText) return res.status(200).json({ reply: {
      spoken: "Jag hörde inget tydligt – säg igen så tar vi det.",
      need: { clarify: true, question: "Kan du säga det igen?" },
      cards: { summary: "Otydligt", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
      follow_up: ""
    }});
    const smalltalk = isSmalltalk(userText);

    // 2) Hämta manual-kontekst (även för småprat – men vi använder den bara om relevant)
    const { context, coverage, matchedHeadings } = smalltalk ? { context:"", coverage:0, matchedHeadings:[] } : await retrieveContext(userText, 8);

    // 3) System-prompt
    const system = `
Du är en AI-assistent för Linje 65 – tänk JARVIS, fast på svenska: varm, kvick när det passar, men rak och pålitlig.
Regler:
- Operativa råd (procedurer, säkerhet, kvalitet, felsökning, parametrar) måste bygga på "ManualContext".
- Hitta inte på siffror/parametrar som inte står i manualen.
- Om underlaget är otydligt: ge ett preliminärt säkert svar och ställ EN konkret följdfråga.
- Småprat/allmänna frågor: svara fritt och trevligt (ignorera manualen).
- Returnera STRIKT JSON enligt detta schema:

{
  "spoken": string,                       // kort, naturligt tal
  "need": { "clarify": boolean, "question"?: string },
  "cards": {
    "summary": string,
    "steps": string[],
    "explanation": string,
    "pitfalls": string[],
    "simple": string,
    "pro": string,
    "follow_up": string,
    "coverage": number,                   // 0..1
    "matched_headings": string[]
  },
  "follow_up": string
}
    `.trim();

    // 4) User-prompt med RAG-kontekst
    const user = `
ManualContext (ur aktiv manual):
${context || "(tom)"}

Täckningsindikator (0..1, heuristik): ${coverage.toFixed(3)}
Tidigare tur: ${prev ? JSON.stringify(prev) : "null"}
Historik (kort): ${history && history.length ? JSON.stringify(history.slice(-6)) : "[]"}

Användarens fråga/uttalande:
"""${userText}"""

Instruktioner:
- Om detta är småprat: svara fritt, "need.clarify=false", "coverage"=0 och "matched_headings"=[].
- Om detta är operativt: bygg svaret från ManualContext. Sätt "matched_headings" till relevanta rubriker. Sätt "coverage" till ${coverage.toFixed(2)} (justera lite om du behöver).
- Om ManualContext är för svag (t.ex. coverage < 0.5): ge inga exakta steg, ställ EN precisering.
- Var konkret och pedagogisk. Numrera steg när relevant.
    `.trim();

    // 5) LLM
    let out = await callLLM(system, user, 0.6, 1800);

    // 6) Sista säkerhet: injicera matched_headings & coverage från retrieval om modellen glömmer
    if (!out.cards) out.cards = {};
    if (!Array.isArray(out.cards.matched_headings) || out.cards.matched_headings.length === 0) {
      out.cards.matched_headings = matchedHeadings;
    }
    if (typeof out.cards.coverage !== "number" || isNaN(out.cards.coverage)) {
      out.cards.coverage = coverage;
    }

    // 7) Om den vill klarifiera men du redan preciserade i förra vändan med ett kort svar → milda
    const prevWanted = !!(prev && prev.assistant && prev.assistant.need && prev.assistant.need.clarify);
    const isVeryShort = userText.split(/\s+/).filter(Boolean).length <= 3;
    if (out?.need?.clarify && prevWanted && isVeryShort) {
      // gör en lite mer handlingskraftig variant
      out.need = { clarify: false };
      out.spoken = out.spoken && out.spoken.length > 4 ? out.spoken : "Toppen – då kör vi på det.";
    }

    // 8) Returnera
    return res.status(200).json({ reply: out });

  } catch (err) {
    console.error("chat.js internal error:", err);
    return res.status(500).json({ error: "Serverfel i chat.js", details: err.message || String(err) });
  }
}
