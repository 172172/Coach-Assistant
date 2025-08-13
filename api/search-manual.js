import { q } from "./db.js";
export const config = { api: { bodyParser: true } };

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const MODEL_1536 = "text-embedding-3-small";  // 1536-dim
const MODEL_3072 = "text-embedding-3-large";  // 3072-dim

async function getSchemaAndColumns() {
  const r = await q(
    `select table_schema, column_name
       from information_schema.columns
      where table_name = 'manual_chunks'`
  );
  if (!r.rows?.length) throw new Error("Hittar inte manual_chunks i information_schema");
  const schema = r.rows[0].table_schema || "public";
  const cols = new Set(r.rows.map(x => x.column_name));
  const pick = (...names) => names.find(n => cols.has(n)) || null;

  const contentCol = pick("content", "text", "chunk", "body");
  const sectionCol = pick("section", "heading", "title", "path");
  const sourceCol  = pick("source", "doc", "filename", "origin");
  const manualIdCol = pick("manual_id", "doc_id");
  if (!contentCol) throw new Error("Hittar ingen textkolumn i manual_chunks (content/text/chunk/body)");

  return { schema, contentCol, sectionCol, sourceCol, manualIdCol };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });
  try {
    const { query, topK, minSim } = req.body || {};
    if (!query?.trim()) return res.status(400).json({ error: "Missing query" });

    const { schema, contentCol, sectionCol, sourceCol, manualIdCol } = await getSchemaAndColumns();

    // dimensioner -> modell
    const dimRow = await q(`select vector_dims(embedding) as dim from ${schema}.manual_chunks limit 1`);
    const dims = dimRow.rows?.[0]?.dim;
    if (!dims) return res.status(200).json({ ok: true, count: 0, snippets: [], context: "", note: "manual_chunks saknar rader" });

    const model = (dims === 1536) ? MODEL_1536 : (dims === 3072) ? MODEL_3072 : null;
    if (!model) return res.status(500).json({ ok: false, error: `Okänd vektor-dimension ${dims}. Re-embedda med 1536 eller 3072.` });

    // 1) embedding
    const er = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: query })
    });
    const ej = await er.json();
    if (!er.ok) return res.status(500).json({ error: "Embedding error", details: ej });
    const embedding = ej?.data?.[0]?.embedding;
    if (!embedding?.length) return res.status(500).json({ error: "No embedding returned" });
    const vec = `[${embedding.join(",")}]`;

    const k = Number(topK ?? process.env.RAG_TOP_K ?? 6);
    let min = Number(minSim ?? process.env.RAG_MIN_SIMILARITY ?? 0.6);

    // 2) bygg SELECT dynamiskt
    const fields = [
      `id`,
      manualIdCol ? `${manualIdCol} as manual_id` : `null as manual_id`,
      sectionCol ? `${sectionCol} as section` : `null as section`,
      `${contentCol} as content`,
      `1 - (embedding <=> $1::vector) as similarity`,
      sourceCol ? `${sourceCol} as source` : `null as source`
    ].join(", ");

    async function search(threshold) {
      const sql = `
        select ${fields}
          from ${schema}.manual_chunks
         where 1 - (embedding <=> $1::vector) >= $3
         order by embedding <=> $1::vector
         limit $2`;
      const r = await q(sql, [vec, k, threshold]);
      return r.rows || [];
    }

    let rows = await search(min);
    if (rows.length === 0 && min > 0.45) rows = await search(0.45);

    const snippets = rows.map(r => ({
      id: r.id,
      manual_id: r.manual_id,
      section: r.section,
      content: r.content,
      similarity: Number((r.similarity ?? 0).toFixed(3)),
      source: r.source
    }));

    const context = snippets
      .map((r, i) => `[#${i + 1} | ${r.section || "sektion"} | ${r.source || "manual"} | sim:${r.similarity}]
${r.content}`)
      .join("\n\n---\n\n");

    res.status(200).json({ ok: true, count: snippets.length, snippets, context, dims, modelUsed: model, schema });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
