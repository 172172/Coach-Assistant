import { q } from "./db.js";
import fetch from "node-fetch";
export const config = { api: { bodyParser: true } }; // Node, inte Edge

const MODEL = "text-embedding-3-large";

const toPgVector = a => "[" + a.map(n => (typeof n === "number" ? n : Number(n)||0)).join(",") + "]";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"POST only" });
  try {
    const { query } = req.body || {};
    if (!query?.trim()) return res.status(400).json({ ok:false, error:"Missing query" });

    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({ model: MODEL, input: query })
    });
    if (!embRes.ok) return res.status(500).json({ ok:false, error:`Embeddings API: ${await embRes.text()}` });
    const vec = (await embRes.json())?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) return res.status(500).json({ ok:false, error:"No embedding" });

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
    const r = await q(sql, [toPgVector(vec)]);
    const snippets = r.rows.map(x => ({
      doc_id: x.doc_id, title: x.title, idx: x.idx, heading: x.heading,
      score: Number((x.score ?? 0).toFixed(4)), text: x.chunk
    }));
    res.status(200).json({ ok:true, count:snippets.length, snippets,
      context: snippets.map(s=>s.text).join("\n---\n") });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
}
