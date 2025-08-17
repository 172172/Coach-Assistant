// /api/search-manual.js – v2 (ren JavaScript, inga TypeScript-annotationer)
// För Next.js/Vercel Node runtime. Sök i manual med pgvector (cosine).
// Fixar troliga 500-fel: tog bort TS-typer, tydligare fel, robust rubrikfilter.

import { Pool } from 'pg';

// ---------- DB pool ----------
const pool =
  global.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  });
if (!global.pgPool) global.pgPool = pool;

// ---------- Helpers ----------
function readJsonBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return req.body;
  } catch {
    return {};
  }
}

function quoteIdent(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

async function embedQuery(q) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY saknas (env)');
  const model = process.env.EMBED_MODEL || 'text-embedding-3-small'; // 1536-dim
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: q }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI embeddings misslyckades: ${r.status} ${r.statusText} – ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const emb = j.data && j.data[0] && j.data[0].embedding;
  if (!emb) throw new Error('Embedding saknas i OpenAI-svar');
  return { embedding: emb, model, dims: emb.length };
}

async function tableExists(schema, table) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2 LIMIT 1`,
    [schema, table]
  );
  return rows.length > 0;
}

async function columns(schema, table) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`,
    [schema, table]
  );
  return rows.map((r) => r.column_name);
}

async function getMappings() {
  const schema = process.env.MANUAL_SCHEMA || 'public';
  const chunksTable = process.env.MANUAL_TABLE || 'manual_chunks';
  const docsTable = process.env.MANUAL_DOCS_TABLE || 'manual_docs';

  const chunkCols = await columns(schema, chunksTable);
  const pick = (envName, cands) => {
    const v = process.env[envName];
    if (v && chunkCols.includes(v)) return v;
    return cands.find((c) => chunkCols.includes(c));
  };

  const textCol = pick('MANUAL_TEXT_COL', ['chunk', 'content', 'text', 'body', 'raw', 'paragraph']);
  const embCol = pick('MANUAL_EMB_COL', ['embedding', 'vector', 'emb', 'embedding_1536', 'embed']);
  const idxCol = pick('MANUAL_IDX_COL', ['idx', 'chunk_index', 'position', 'ord', 'i']);
  const headingCol = pick('MANUAL_HEADING_COL', ['heading', 'section', 'h1', 'h2']);
  const docIdCol = pick('MANUAL_DOCID_COL', ['doc_id', 'document_id', 'docid', 'source_id', 'doc']);

  if (!textCol)
    throw new Error('Kunde inte hitta textkolumn i manualtabellen (chunk/content/text/body/raw/paragraph). Sätt MANUAL_TEXT_COL.');
  if (!embCol)
    throw new Error('Kunde inte hitta embedding-kolumn i manualtabellen (embedding/vector/emb/embedding_1536/embed). Sätt MANUAL_EMB_COL.');

  let join = { exists: false };
  if (await tableExists(schema, docsTable)) {
    const docsCols = await columns(schema, docsTable);
    const pickDocs = (envName, cands) => {
      const v = process.env[envName];
      if (v && docsCols.includes(v)) return v;
      return cands.find((c) => docsCols.includes(c));
    };
    join = {
      exists: true,
      schema,
      table: docsTable,
      idCol: pickDocs('MANUAL_DOCS_ID_COL', ['id', 'doc_id', 'document_id', 'docid']),
      titleCol: pickDocs('MANUAL_DOCS_TITLE_COL', ['title', 'name', 'doc_title']),
    };
  }

  return { schema, chunksTable, textCol, embCol, idxCol, headingCol, docIdCol, join };
}

function buildSQL(map, { filtered, heading, restrict }) {
  const sel = [];
  sel.push(map.join.exists ? (map.join.titleCol ? `d.${quoteIdent(map.join.titleCol)} AS title` : `NULL AS title`) : `NULL AS title`);
  sel.push(map.docIdCol ? `c.${quoteIdent(map.docIdCol)} AS doc_id` : `NULL AS doc_id`);
  sel.push(map.idxCol ? `c.${quoteIdent(map.idxCol)} AS idx` : `NULL AS idx`);
  sel.push(map.headingCol ? `c.${quoteIdent(map.headingCol)} AS heading` : `NULL AS heading`);
  sel.push(`c.${quoteIdent(map.textCol)} AS chunk`);
  sel.push(`1 - (c.${quoteIdent(map.embCol)} <=> (SELECT emb FROM q)) AS score`);

  const fromJoin = map.join.exists && map.docIdCol
    ? `FROM ${quoteIdent(map.schema)}.${quoteIdent(map.chunksTable)} c
       LEFT JOIN ${quoteIdent(map.join.schema)}.${quoteIdent(map.join.table)} d
         ON d.${quoteIdent(map.join.idCol)} = c.${quoteIdent(map.docIdCol)}`
    : `FROM ${quoteIdent(map.schema)}.${quoteIdent(map.chunksTable)} c`;

  const where = [];
  if (filtered) where.push(`1 - (c.${quoteIdent(map.embCol)} <=> (SELECT emb FROM q)) >= $3`);

  if (heading && restrict) {
    const headCol = map.headingCol ? `c.${quoteIdent(map.headingCol)}` : `NULL`;
    const titleCol = map.join.exists && map.join.titleCol ? `d.${quoteIdent(map.join.titleCol)}` : `NULL`;
    const paramIndex = filtered ? 4 : 3;
    where.push(`(COALESCE(${headCol}, '') ILIKE $${paramIndex} OR COALESCE(${titleCol}, '') ILIKE $${paramIndex})`);
  }

  return `
    WITH q AS (SELECT $1::vector AS emb)
    SELECT ${sel.join(',\n           ')}
    ${fromJoin}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.${quoteIdent(map.embCol)} <=> (SELECT emb FROM q)
    LIMIT $2
  `;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST')
    return res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));

  try {
    const body = readJsonBody(req);
    const q = (body.query || '').trim();
    const K = Math.min(Math.max(parseInt(body.k || body.topK || 5, 10) || 5, 1), 20);
    const minScore = typeof body.minSim === 'number' ? body.minSim : 0.4;
    const heading = body.heading ? String(body.heading).trim() : null;
    const restrict = !!body.restrictToHeading;

    if (!q) return res.status(400).end(JSON.stringify({ ok: false, error: 'Tom query' }));

    const { embedding, dims } = await embedQuery(q);
    const vecLiteral = '[' + embedding.map((x) => Number(x).toFixed(6)).join(',') + ']';

    const map = await getMappings();

    let sql = buildSQL(map, { filtered: true, heading, restrict });
    let params = [vecLiteral, K, minScore];
    if (heading && restrict) params.push(`%${heading}%`);

    let rows = [];
    try {
      const r = await pool.query(sql, params);
      rows = r.rows || [];
    } catch (dbErr) {
      if (/does not exist/i.test(dbErr.message))
        throw new Error('Tabell/kolumn eller typ saknas – kontrollera MANUAL_* env och pgvector-installation.');
      if (/type vector/i.test(dbErr.message))
        throw new Error('pgvector saknas – kör CREATE EXTENSION vector; och säkerställ vector(1536).');
      if (/is of type .* but expression is of type/i.test(dbErr.message))
        throw new Error('Kolumntyp felaktig – säkerställ att embedding-kolumnen är vector(1536).');
      throw dbErr;
    }

    let usedFallback = false;
    if (!rows.length) {
      usedFallback = true;
      sql = buildSQL(map, { filtered: false, heading, restrict });
      params = [vecLiteral, K];
      if (heading && restrict) params.push(`%${heading}%`);
      const r2 = await pool.query(sql, params);
      rows = r2.rows || [];
    }

    return res.status(200).end(JSON.stringify({
      ok: true,
      query: q,
      k: K,
      dims,
      heading: heading || null,
      restricted: restrict,
      fallback: usedFallback,
      snippets: rows.map((r) => ({
        doc_id: r.doc_id ?? null,
        title: r.title ?? null,
        idx: r.idx ?? null,
        heading: r.heading ?? null,
        score: Number((r.score ?? 0).toFixed(4)),
        text: r.chunk,
      })),
    }));
  } catch (err) {
    console.error('search-manual 500', err);
    res.status(500).end(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
  }
}

/*
SQL att köra (en gång) för prestanda:

CREATE EXTENSION IF NOT EXISTS vector;
-- ALTER TABLE public.manual_chunks ALTER COLUMN embedding TYPE vector(1536);
CREATE INDEX IF NOT EXISTS manual_chunks_emb_cos_idx
  ON public.manual_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
ANALYZE public.manual_chunks;
*/
