// /api/search-manual.js
import { q } from "./db.js";
import fetch from "node-fetch";

export const config = { api: { bodyParser: true } }; // säkerställ Node, inte Edge

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-large"; // måste matcha vektor-dimensionen i tabellen

function toPgVectorString(arr) {
  return "[" + arr.map(v => (typeof v === "number" ? v : Number(v) || 0)).join(",") + "]";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error: "POST only" });
  try {
    const { query } = req.body || {};
    if (!query?.trim()) return res.status(400).json({ ok:false, error: "Missing query" });

    // 1) Hämta embedding för frågan
    const embRes = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: MODEL, input: query })
    });
    if (!embRes.ok) return res.status(500).json({ ok:false, error: `Embeddings API failed: ${await embRes.text()}` });
    const vec = (await embRes.json())?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) return res.status(500).json({ ok:false, error: "No embedding returned" });
    const qvec = toPgVectorString(vec);

    // 2) Vektor-sök i aktiva dokument
    const sql = `
      with params as (select $1::vector as qvec)
      select c.doc_id, d.title, c.idx, c.heading, c.chunk,
             1 - (c.embedding <=> p.qvec) as score
      from manual_chunks c
      join manual_docs d on d.id = c.doc_id
      cross join params p
      where d.is_active = true
      order by c.embedding <=> p.qvec
      limit 8
    `;
    const r = await q(sql, [qvec]);

    const snippets = r.rows.map(x => ({
      doc_id: x.doc_id, title: x.title, idx: x.idx, heading: x.heading,
      score: Number((x.score ?? 0).toFixed(4)), text: x.chunk
    }));
    const context = snippets.map(s => s.text).join("\n---\n");

    return res.status(200).json({ ok: true, count: snippets.length, snippets, context });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
}
