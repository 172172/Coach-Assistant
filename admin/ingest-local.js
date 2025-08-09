
// /api/admin/ingest.js
// POST { title, markdown, setActive?: true }
import { q } from "../db.js";
import fetch from "node-fetch";

export const config = { api: { bodyParser: true } };

// Dela upp markdown i rubrik-baserade chunkar (~1200 tecken)
function splitIntoChunks(md) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let cur = { heading: "Förord", content: [] };

  for (const line of lines) {
    const m = line.match(/^(#{2,4})\s*(.+?)\s*$/);
    if (m) {
      if (cur.content.length)
        sections.push({ heading: cur.heading, text: cur.content.join("\n").trim() });
      cur = { heading: m[2].trim(), content: [] };
    } else {
      cur.content.push(line);
    }
  }
  if (cur.content.length)
    sections.push({ heading: cur.heading, text: cur.content.join("\n").trim() });

  const MAX = 1200, out = [];
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
  return out.filter(c => c.chunk && c.chunk.replace(/\W/g, "").length > 40);
}

async function embedAll(texts) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts })
  });
  const j = await r.json();
  if (!r.ok) { console.error("Embeddings error:", j); throw new Error("Embeddings API error"); }
  return j.data.map(d => d.embedding);
}

const toPgVector = (arr) => "[" + arr.map(x => (x ?? 0).toFixed(6)).join(",") + "]";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { title = "Manual Linje 65", markdown = "", setActive = true } = req.body || {};
    if (!markdown || markdown.trim().length < 50)
      return res.status(400).json({ error: "Markdown saknas eller är för kort" });

    const chunks = splitIntoChunks(markdown);
    const embeddings = await embedAll(chunks.map(c => c.chunk));

    if (setActive) await q("update manual_docs set is_active = false where is_active = true");
    const doc = await q(
      "insert into manual_docs (title, version, is_active) values ($1, coalesce((select max(version)+1 from manual_docs),1), $2) returning id, version",
      [title, !!setActive]
    );
    const docId = doc.rows[0].id;

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      await q(
        "insert into manual_chunks (doc_id, heading, idx, chunk, embedding) values ($1,$2,$3,$4,$5::vector)",
        [docId, c.heading, i, c.chunk, toPgVector(embeddings[i])]
      );
    }

    res.status(200).json({ ok: true, docId, version: doc.rows[0].version, count: chunks.length });
  } catch (e) {
    console.error("ingest error:", e);
    res.status(500).json({ error: "Serverfel vid ingest", details: e.message || String(e) });
  }
}
