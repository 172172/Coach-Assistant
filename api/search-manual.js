// /api/search-manual.js
// Serverless-funktion för Vercel/Next "pages" stil (CommonJS).
// Kräver: OPENAI_API_KEY + Postgres-anslutning (DATABASE_URL eller PG* envs).
// Kräver i databasen: CREATE EXTENSION IF NOT EXISTS vector;
// och en tabell (default: public.manual_chunks) med kolumnen "embedding vector(1536)".

const { Pool } = require('pg');

// --- Pool (återanvänd mellan anrop) ---
const pool =
  global.pgPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.PGSSL === 'false'
        ? false
        : { rejectUnauthorized: false },
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE
  });
if (!global.pgPool) global.pgPool = pool;

// --- OpenAI embedding (utan SDK, bara fetch) ---
async function embedQuery(query) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const model = process.env.EMBED_MODEL || 'text-embedding-3-small'; // 1536 dims
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input: query })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(
      `OpenAI embeddings failed: ${r.status} ${r.statusText} – ${t.slice(0, 200)}`
    );
  }
  const j = await r.json();
  const emb = j.data?.[0]?.embedding;
  if (!emb) throw new Error('No embedding returned');
  return { embedding: emb, model, dims: emb.length };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }
  try {
    const body = req.body || {};
    const query = (body.query || '').trim();
    if (!query) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'Missing query' }));
      return;
    }
    const K = Number(body.k ?? body.topK ?? 5);
    const minScore = Number(body.minSim ?? 0); // 0..1

    // 1) Embedding
    const { embedding, model, dims } = await embedQuery(query);
    const vecLiteral = '[' + embedding.join(',') + ']'; // skickas som $1::vector

    // 2) Tabell/kolumnnamn (konfig via env om du vill)
    const schema = process.env.MANUAL_SCHEMA || 'public';
    const table = process.env.MANUAL_TABLE || 'manual_chunks';
    const embCol = process.env.MANUAL_EMB_COL || 'embedding';
    const textCol = process.env.MANUAL_TEXT_COL || 'chunk';
    const titleCol = process.env.MANUAL_TITLE_COL || 'title';
    const headingCol = process.env.MANUAL_HEADING_COL || 'heading';
    const idxCol = process.env.MANUAL_IDX_COL || 'idx';
    const docIdCol = process.env.MANUAL_DOCID_COL || 'doc_id';

    // 3) Likhet & sortering med pgvector
    // score = 1 - cosine_distance; filtrera på minSim om satt
    const sql = `
      WITH q AS (SELECT $1::vector AS emb)
      SELECT ${docIdCol} AS doc_id,
             ${titleCol}  AS title,
             ${idxCol}    AS idx,
             ${headingCol} AS heading,
             ${textCol}   AS chunk,
             1 - (${embCol} <=> (SELECT emb FROM q)) AS score
      FROM ${schema}.${table}
      WHERE 1 - (${embCol} <=> (SELECT emb FROM q)) >= $3
      ORDER BY ${embCol} <-> (SELECT emb FROM q)
      LIMIT $2
    `;

    const { rows } = await pool.query(sql, [vecLiteral, K, minScore]);

    res.status(200).end(
      JSON.stringify({
        ok: true,
        count: rows.length,
        model,
        dims,
        snippets: rows.map((r) => ({
          doc_id: r.doc_id,
          title: r.title,
          idx: r.idx,
          heading: r.heading,
          score: Number((r.score ?? 0).toFixed(4)),
          text: r.chunk
        }))
      })
    );
  } catch (err) {
    console.error('search-manual 500', err);
    res
      .status(500)
      .end(JSON.stringify({ ok: false, error: String(err.message || err) }));
  }
};
