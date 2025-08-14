// ESM-version för Vercel Node-funktioner (project har "type":"module")
import { Pool } from 'pg';

// Pool återanvänds mellan anrop
const pool =
  globalThis.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE
  });
if (!globalThis.pgPool) globalThis.pgPool = pool;

// Body-parser som tål både string och objekt
function readJsonBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return req.body;
  } catch {
    return {};
  }
}

// Använder Node 18+/20+ inbyggda fetch (du behöver inte node-fetch)
async function embedQuery(query) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY saknas (env)');
    err.code = 'NO_OPENAI_KEY';
    throw err;
  }
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
    const err = new Error(`OpenAI embeddings misslyckades: ${r.status} ${r.statusText} – ${t.slice(0,200)}`);
    err.code = 'EMBED_FAIL';
    throw err;
  }
  const j = await r.json();
  const emb = j.data?.[0]?.embedding;
  if (!emb) {
    const err = new Error('Embedding saknas i OpenAI-svar');
    err.code = 'NO_EMBED';
    throw err;
  }
  return { embedding: emb, model, dims: emb.length };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }

  try {
    const body = readJsonBody(req);
    const query = String((body.query || '')).trim();
    if (!query) {
      res.status(400).end(JSON.stringify({ ok: false, error: 'Missing query' }));
      return;
    }
    const K = Number(body.k ?? body.topK ?? 5);
    const minScore = Number(body.minSim ?? 0); // 0..1

    // 1) Embedding
    const { embedding, model, dims } = await embedQuery(query);
    const vecLiteral = `[${embedding.join(',')}]`;

    // 2) Tabell/kolumner (styr via env om du vill byta namn)
    const schema     = process.env.MANUAL_SCHEMA     || 'public';
    const table      = process.env.MANUAL_TABLE      || 'manual_chunks';
    const embCol     = process.env.MANUAL_EMB_COL    || 'embedding';
    const textCol    = process.env.MANUAL_TEXT_COL   || 'chunk';
    const titleCol   = process.env.MANUAL_TITLE_COL  || 'title';
    const headingCol = process.env.MANUAL_HEADING_COL|| 'heading';
    const idxCol     = process.env.MANUAL_IDX_COL    || 'idx';
    const docIdCol   = process.env.MANUAL_DOCID_COL  || 'doc_id';

    // 3) Vektorsökning (cosine). Filtrera på minSim och sortera på avstånd.
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

    let rows;
    try {
      const r = await pool.query(sql, [vecLiteral, K, minScore]);
      rows = r.rows || [];
    } catch (dbErr) {
      const msg = String(dbErr?.message || dbErr);
      if (msg.includes('relation') && msg.includes('does not exist')) {
        throw new Error('Tabellen saknas. Skapa public.manual_chunks (se SQL).');
      }
      if (msg.includes('<->') || msg.includes('<=>')) {
        throw new Error('pgvector saknas. Kör: CREATE EXTENSION IF NOT EXISTS vector;');
      }
      if (msg.includes('dimension mismatch')) {
        throw new Error('Dimensionsfel: kolumnen måste vara vector(1536) för text-embedding-3-small.');
      }
      throw dbErr;
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      count: rows.length,
      model,
      dims,
      snippets: rows.map(r => ({
        doc_id: r.doc_id,
        title: r.title,
        idx: r.idx,
        heading: r.heading,
        score: Number((r.score ?? 0).toFixed(4)),
        text: r.chunk
      }))
    }));
  } catch (err) {
    console.error('search-manual 500', err);
    res.status(500).end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  }
}
