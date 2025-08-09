// /api/chat.js
// Manual-först röstmentor för Linje 65 med lätt RAG (semantisk sökning).
// Operativa svar får ENDAST bygga på manuella utdrag som hämtas här. Ingen påhittad info.

const KNOWLEDGE_URL = "https://raw.githubusercontent.com/172172/Coach-Assistant/main/assistant-knowledge.txt";
const CACHE_MS = 5 * 60 * 1000; // 5 min cache

let knowledgeCache = { text: null, fetchedAt: 0 };
let ragCache = { sections: [], vectors: [], fetchedAt: 0, builtAt: 0 }; // in-memory index

async function fetchManual() {
  const now = Date.now();
  if (knowledgeCache.text && now - knowledgeCache.fetchedAt < CACHE_MS) return knowledgeCache.text;
  const res = await fetch(KNOWLEDGE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Misslyckades hämta kunskap: ${res.status}`);
  const text = await res.text();
  knowledgeCache = { text, fetchedAt: now };
  return text;
}

// ---------- Text utils ----------
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

// ---------- Chunka manualen till rubrik-sektioner ----------
function splitIntoSections(manual) {
  const lines = manual.split(/\r?\n/);
  const secs = [];
  let current = { heading: "Förord", content: [] };
  for (const line of lines) {
    const m = line.match(/^(#{2,4})\s*(.+?)\s*$/); // ## ... / ### ...
    if (m) {
      // push föregående om den har innehåll
      if (current.content.length) {
        secs.push({ heading: current.heading, text: current.content.join("\n").trim() });
      }
      current = { heading: m[2].trim(), content: [] };
    } else {
      current.content.push(line);
    }
  }
  if (current.content.length) {
    secs.push({ heading: current.heading, text: current.content.join("\n").trim() });
  }
  // chunk stora sektioner i mindre bitar (~1200 tecken)
  const out = [];
  const MAX_CHUNK = 1200;
  for (const s of secs) {
    const base = `${s.heading}\n${s.text}`.trim();
    if (base.length <= MAX_CHUNK) { out.push({ heading: s.heading, chunk: base }); continue; }
    // dela vid tomrad/meningsslut
    const parts = s.text.split(/\n\s*\n/);
    let buf = s.heading + "\n";
    for (const p of parts) {
      if ((buf + p).length > MAX_CHUNK) {
        out.push({ heading: s.heading, chunk: buf.trim() });
        buf = s.heading + "\n" + p + "\n";
      } else {
        buf += p + "\n\n";
      }
    }
    if (buf.trim().length) out.push({ heading: s.heading, chunk: buf.trim() });
  }
  // rensa triviala
  return out.filter(s => s.chunk && s.chunk.replace(/\W/g,"").length > 40);
}

// ---------- Embeddings ----------
async function embedAll(texts) {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts })
  });
  const json = await resp.json();
  if (!resp.ok) {
    console.error("Embeddings error:", json);
    throw new Error("Embeddings API error");
  }
  return json.data.map(e => e.embedding);
}
function cosine(a, b) {
  let dot=0, na=0, nb=0;
  for (let i=0;i<a.length;i++){ const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-8);
}

// ---------- Bygg/uppdatera RAG-index ----------
async function ensureIndex() {
  const manual = await fetchManual();
  const now = Date.now();
  if (ragCache.sections.length && now - ragCache.fetchedAt < CACHE_MS) return ragCache; // nyligen byggt

  const sections = splitIntoSections(manual);
  const texts = sections.map(s => s.chunk);
  const vectors = await embedAll(texts);

  ragCache = { sections, vectors, fetchedAt: now, builtAt: now };
  return ragCache;
}

async function retrieve(query, prev) {
  const { sections, vectors } = await ensureIndex();
  const qtext = [query, prev?.question || "", prev?.assistant?.spoken || ""].filter(Boolean).join("\n");
  const qvec = (await embedAll([qtext]))[0];

  // rank
  const scored = vectors.map((v, i) => ({ i, s: cosine(qvec, v) }));
  scored.sort((a,b)=> b.s - a.s);

  // välj top-K med enkel tröskel
  const K = 8;
  const top = scored.slice(0, K).filter(x => x.s > 0.17); // låg men praktisk tröskel
  const picked = top.map(x => ({ ...sections[x.i], score: x.s }));

  // beräkna "coverage" uppskattning
  const avg = top.length ? top.map(x=>x.s).reduce((a,b)=>a+b,0)/top.length : 0;
  const coverage = Math.max(0, Math.min(1, avg * 1.6)); // skala lätt upp

  // gruppera rubriker (unika)
  const matched_headings = Array.from(new Set(picked.map(p => p.heading)));

  // bygg promptblock
  const context = picked.map((p, idx) => `### [S${idx+1}] ${p.heading}\n${p.chunk}`).join("\n\n");

  return { context, matched_headings, coverage, any: picked.length>0 };
}

// ---------- OpenAI chat helper ----------
async function callOpenAI(system, user, { temperature=0.4, max_tokens=1700 } = {}) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature,
      max_tokens,
      messages: [{ role:"system", content: system }, { role:"user", content: user }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("OpenAI chat error:", data);
    throw new Error("Chat API error");
  }
  let content = data.choices?.[0]?.message?.content || "";
  let out;
  try { out = JSON.parse(content); }
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

// ---------- API handler ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message = "", prev = null } = req.body || {};

    // 1) Småprat? Ge trevligt svar och klart.
    if (isSmalltalk(message) && !looksOperational(message)) {
      const out = {
        spoken: "Jag mår fint — AI-pigg. Hur är läget hos dig?",
        need: { clarify: false },
        cards: { summary:"Småprat", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] },
        follow_up: ""
      };
      return res.status(200).json({ reply: out });
    }

    // 2) Hämta relevanta stycken ur manualen (RAG)
    const { context, matched_headings, coverage, any } = await retrieve(message, prev);

    // 3) Bygg strikt systemprompt: operativt = endast från 'KONTEKST' nedan
    const system = `
Du är en röstmentor för Linje 65 — Douglas Adams + JARVIS ton, men saklig och trygg.
Svara alltid på svenska. Var varm, kvick där det passar (inte vid säkerhet). Tala naturligt i "spoken".

VIKTIGT OM KÄLLOR:
- Du får en KONTEKST med utdrag ur manualen. **OPERATIVA råd (procedurer, kvalitet, säkerhet, felsökning, parametrar) får ENDAST baseras på denna KONTEKST.**
- Om KONTEKST inte räcker: ställ EN öppen följdfråga eller säg att det inte täcks och föreslå uppdatering. Hitta inte på.
- Allmänna frågor (ej operativa) kan besvaras fritt.

"spoken" – håll korta, mänskliga meningar; små bekräftelser ("kanon", "vi tar det"); numrera steg med "Steg ett:", "Steg två:" när relevant.

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

    // 4) Userprompt med *bara* de hämtade styckena
    const user = `
KONTEKST (utdrag ur manualen, använd endast detta för operativa svar):
${any ? context : "(tomt — inget matchande avsnitt hittades)"}

Tidigare tur (för sammanhang):
${prev ? JSON.stringify(prev) : "null"}

Användarens inmatning:
"${message}"

Instruktioner:
- Om frågan är operativ och KONTEKST är tom/otillräcklig: need.clarify=true och ställ EN fråga som hjälper dig hitta rätt rubrik (fråga inte samma sak igen).
- Om KONTEKST räcker: ge tydliga, numrerade steg och fyll matched_headings med relevanta rubriker (från KONTEKST).
- Ange "cards.coverage" realistiskt (förslag: ${coverage.toFixed(2)}).
- Ingen text utanför JSON.
`.trim();

    // 5) Modellkörning
    let out = await callOpenAI(system, user, { temperature: 0.38, max_tokens: 1700 });

    // 6) Efterkontroll: se till att matched_headings inte pekar utanför KONTEKST
    const allowed = new Set(matched_headings);
    if (!out.cards) out.cards = { summary:"", steps:[], explanation:"", pitfalls:[], simple:"", pro:"", follow_up:"", coverage:0, matched_headings:[] };
    out.cards.matched_headings = Array.isArray(out.cards.matched_headings)
      ? out.cards.matched_headings.filter(h => allowed.has(h))
      : [];

    // Om modellen gav steg men inga rubriker — fyll med våra hittade
    if (out.cards.matched_headings.length === 0 && out.cards.steps && out.cards.steps.length) {
      out.cards.matched_headings = matched_headings.slice(0, 4);
    }

    // Sätt coverage om saknas/0
    if (!(typeof out.cards.coverage === "number" && isFinite(out.cards.coverage))) {
      out.cards.coverage = coverage;
    }

    // 7) Sista säkring: om frågan ser operativ ut men KONTEKST var tom och modellen ändå försökte guida → stoppa och fråga istället
    if (looksOperational(message) && !any && (out.cards.steps?.length || /steg|öppna|st[aä]ng|tryck|temperatur|ventil/i.test(out.spoken||""))) {
      out = {
        spoken: "Det där låter operativt, men jag hittar inget i manualen just nu. Säg exakt vilket moment eller rubrik det gäller, så plockar jag rätt avsnitt.",
        need: { clarify: true, question: "Vilken rubrik/utrustning avser du? (t.ex. 'Tapp – gul lampa', 'Tapp – sortbyte', 'CIP – tapp')" },
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
