import { q, getSupa } from "./db.js";
export const config = { api: { bodyParser: true } };

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const MODEL_1536 = "text-embedding-3-small";
const MODEL_3072 = "text-embedding-3-large";

async function embed(input, model) {
  const r = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "Embedding failed");
  return j.data[0].embedding;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });
  try {
    const { query, topK, minSim } = req.body || {};
    if (!query?.trim()) return res.status(400).json({ error: "Missing query" });

    const k = Number(topK ?? process.env.RAG_TOP_K ?? 6);
    let min = Number(minSim ?? process.env.RAG_MIN_SIMILARITY ?? 0.6);

    // SUPABASE-vägen (om RPC finns)
    const supa = await getSupa();
    if (supa) {
      let modelUsed = MODEL_3072, emb = await embed(query, MODEL_3072);
      let { data, error } = await supa.rpc("match_manual_chunks", {
        query_embedding: emb, match_count: k, min_similarity: min
      });
      if (error && /dimension|mismatch|vector/i.test(error.message || "")) {
        modelUsed = MODEL_1536;
        emb = await embed(query, MODEL_1536);
        ({ data, error } = await supa.rpc("match_manual_chunks", {
          query_embedding: emb, match_count: k, min_similarity: min
        }));
      }
      if (error) throw error;
      if ((!data || !data.length) && min > 0.45) {
        ({ data } = await supa.rpc("match_manual_chunks", {
          query_embedding: emb, match_count: k, min_similarity: 0.45
        }));
      }
      const snippets = (data || []).map(r => ({
        id: r.id, manual_id: r.manual_id, section: r.section,
        content: r.content, similarity: Number((r.similarity ?? 0).toFixed(3)), source: r.source
      }));
      const context = snippets.map((r, i) => `[#${i+1} | ${r.section || 'sektion'} | ${r.source || 'manual'} | sim:${r.similarity}]\n${r.content}`).join("\n\n---\n\n");
      return res.status(200).json({ ok: true, count: snippets.length, snippets, context, mode: "supabase", modelUsed });
    }

    // PG-vägen (schema-kvalificerad)
    const d = await q("select vector_dims(embedding) as dim from public.manual_chunks limit 1");
    const dims = d.rows?.[0]?.dim;
    const model = (dims === 3072) ? MODEL_3072 : MODEL_1536;
    const emb = await embed(query, model);
    const vec = `[${emb.join(",")}]`;

    const rows1 = await q(
      `select id, manual_id, section, content, source,
              1 - (embedding <=> $1::vector) as similarity
         from public.manual_chunks
        where 1 - (embedding <=> $1::vector) >= $3
        order by embedding <=> $1::vector
        limit $2`,
      [vec, k, min]
    );
    let rows = rows1.rows || [];
    if (rows.length === 0 && min > 0.45) {
      const rows2 = await q(
        `select id, manual_id, section, content, source,
                1 - (embedding <=> $1::vector) as similarity
           from public.manual_chunks
          order by embedding <=> $1::vector
          limit $2`,
        [vec, k]
      );
      rows = rows2.rows || [];
    }

    const snippets = rows.map(r => ({
      id: r.id, manual_id: r.manual_id, section: r.section,
      content: r.content, similarity: Number((r.similarity ?? 0).toFixed(3)), source: r.source
    }));
    const context = snippets.map((r, i) => `[#${i+1} | ${r.section || 'sektion'} | ${r.source || 'manual'} | sim:${r.similarity}]\n${r.content}`).join("\n\n---\n\n");
    res.status(200).json({ ok: true, count: snippets.length, snippets, context, mode: "pg", modelUsed: model, dims });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
