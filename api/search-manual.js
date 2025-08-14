// /api/search-manual.js
import { q } from "./db.js";
import fetch from "node-fetch";

export const config = { api: { bodyParser: true } }; // Node-runtime

const MODEL_BY_DIMS = {
  1536: "text-embedding-3-small",
  3072: "text-embedding-3-large",
};

function toPgVectorString(arr) {
  return "[" + arr.map(v => (typeof v === "number" ? v : Number(v) || 0)).join(",") + "]";
}

async function detectVectorDims() {
  // Försök läsa dimensionen från en rad i manual_chunks
  const r = await q(`select vector_dims(embedding) as dims from manual_chunks limit 1`);
  const dims = r.rows?.[0]?.dims;
  if (dims === 1536 || dims === 3072) return dims;
  // Fallback om tabellen är tom – defaulta till 3072
  return 3072;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"POST only" });

  try {
    const { query, topK = 8 } = req.body || {};
    if (!query?.trim()) return res.status(400).json({ ok:false, error:"Missing query" });

    // 1) Välj rätt modell utifrån DB:ns vektordimension
    const dims = await detectVectorDims();
    const model = MODEL_BY_DIMS[dims] || "text-embedding-3-large";

    // 2) Hämta embedding för frågan
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, input: query })
    });
    if (!embRes.ok) {
      return res.status(500).json({ ok:false, error:`Embeddings API failed: ${await embRes.text()}` });
    }
    const vec = (await embRes.json())?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) return res.status(500).json({ ok:false, error:"No embedding returned" });

    // 3) Vektor-sök i aktiva dokument
    const sql = `
      with params as (select $1::vector as qvec)
      select c.doc_id, d.title, c.idx, c.heading, c.chunk,
             1 - (c.embedding <=> p.qvec) as score
      from manual_chunks c
      join manual_docs d on d.id = c.doc_id
      cross join params p
      where d.is_active = true
      order by c.embedding <=> p.qvec
      limit ${Number(topK) || 8}
    `;
    const r = await q(sql, [toPgVectorString(vec)]);

    const snippets = r.rows.map(x => ({
      doc_id: x.doc_id, title: x.title, idx: x.idx, heading: x.heading,
      score: Number((x.score ?? 0).toFixed(4)), text: x.chunk
    }));
    const context = snippets.map(s => s.text).join("\n---\n");

    return res.status(200).json({ ok:true, dims, model, count:snippets.length, snippets, context });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
}
// lägg direkt efter att du hämtat body
const minSim = Number((req.body && req.body.minSim) ?? 0);

// ...efter SELECTen, innan du bygger snippets:
const rows = r.rows || [];
const filtered = rows.filter(x => (Number(x.score) || 0) >= minSim);

// använd 'filtered' i stället för 'r.rows' nedan
const snippets = filtered.map(x => ({
  doc_id: x.doc_id, title: x.title, idx: x.idx, heading: x.heading,
  score: Number((x.score ?? 0).toFixed(4)), text: x.chunk
}));

