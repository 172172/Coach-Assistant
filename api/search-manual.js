// /api/search-manual.js
import { q } from "./db.js";

export const config = { api: { bodyParser: true } };

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const EMB_MODEL = "text-embedding-3-large";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });
  try {
    const { query, topK, minSim } = req.body || {};
    if (!query?.trim()) return res.status(400).json({ error: "Missing query" });

    const k = Number(topK ?? process.env.RAG_TOP_K ?? 6);
    const min = Number(minSim ?? process.env.RAG_MIN_SIMILARITY ?? 0.6);

    // 1) embedding
    const er = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMB_MODEL, input: query }),
    });
    const ej = await er.json();
    if (!er.ok) return res.status(500).json({ error: "Embedding error", details: ej });
    const embedding = ej?.data?.[0]?.embedding;
    if (!embedding?.length) return res.status(500).json({ error: "No embedding returned" });

    // 2) pgvector-sök (cosine). OBS: embedding som text -> ::vector
    const vec = `[${embedding.join(",")}]`;
    const { rows } = await q(
      `select id, manual_id, section, content,
              1 - (embedding <=> $1::vector) as similarity, source
         from manual_chunks
        where 1 - (embedding <=> $1::vector) >= $3
        order by embedding <=> $1::vector
        limit $2`,
      [vec, k, min]
    );

    const snippets = rows.map(r => ({
      id: r.id,
      manual_id: r.manual_id,
      section: r.section,
      content: r.content,
      similarity: Number((r.similarity ?? 0).toFixed(3)),
      source: r.source,
    }));

    const context = snippets
      .map((r, i) => `[#${i + 1} | ${r.section || "sektion"} | ${r.source || "manual"} | sim:${r.similarity}]
${r.content}`)
      .join("\n\n---\n\n");

    res.status(200).json({ ok: true, count: snippets.length, snippets, context });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
