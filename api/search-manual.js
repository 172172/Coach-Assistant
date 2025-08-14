// /api/search-manual.js  (ESM – funkar med "type":"module")
// Auto-detekterar kolumnnamn i public.manual_chunks (eller enligt env MANUAL_*)

import { Pool } from 'pg';

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

function readJsonBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return req.body;
  } catch { return {}; }
}

async function embedQuery(query) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY saknas (env)');
  const model = process.env.EMBED_MODEL || 'text-embedding-3-small'; // 1536
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: query })
  });
  if (!r.ok) throw new Error(`OpenAI embeddings misslyckades: ${r.status} ${r.statusText}`);
  const j = await r.json();
  const emb = j.data?.[0]?.embedding;
  if (!emb) throw new Error('Embedding saknas i OpenAI-svar');
  return { embedding: emb, model, dims: emb.length };
}

// Hämta kolumner för tabellen och mappa till förväntade alias
async function getColumnMapping(schema, table) {
  const q = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
  `;
  const { rows } = await pool.query(q, [schema, table]);
  const cols = rows.map(r => r.column_name);

  // Om env anger specifika kolumner – använd dem
  const envPick = (envName, listFallback) => {
    const v = process.env[envName];
    if (v && cols.includes(v)) return v;
    return listFallback.find(n => cols.includes(n));
  };

  // Kandidatlistor (case-sensitivt exakt som i catalogen)
  const pick = {
    // *obligatoriska*
    textCol: envPick('MANUAL_TEXT_COL', ['chunk', 'text', 'content', 'body', 'raw', 'paragraph']),
    embCol:  envPick('MANUAL_EMB_COL',  ['embedding', 'vector', 'emb', 'embedding_1536', 'embed']),
    // *valfria* (NULL om saknas)
    titleCol:   envPick('MANUAL_TITLE_COL',   ['title', 'doc_title', 'name']),
    headingCol: envPick('MANUAL_HEADING_COL', ['heading', 'section', 'h1', 'h2']),
    idxCol:     envPick('MANUAL_IDX_COL',     ['idx', 'chunk_index', 'position', 'ord', 'i']),
    docIdCol:   envPick('MANUAL_DOCID_COL',   ['doc_id', 'document_id', 'docid', 'source_id'])
  };

  if (!pick.textCol)  throw new Error('Kunde inte hitta textkolumn (försökte: chunk/text/content/body/raw/paragraph). Sätt MANUAL_TEXT_COL.');
  if (!pick.embCol)   throw new Error('Kunde inte hitta embedding-kolumn (försökte: embedding/vector/emb/embedding_1536/embed). Sätt MANUAL_EMB_COL.');

  return pick;
}

// Hjälp för att citera identifierare korrekt
const id = (s) => `"${s.replace(/"/g, '""')}"`;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).end(JSON.stringify({ ok:false, error:'Method not allowed' }));
    return;
  }

  try {
    const body = readJsonBody(req);
    const query = String((body.query || '')).trim();
    if (!query) return res.status(400).end(JSON.stringify({ ok:false, error:'Missing query' }));
    const K = Number(body.k ?? body.topK ?? 5);
    const minScore = Number(body.minSim ?? 0);

    const { embedding, model, dims } = await embedQuery(query);
    const vecLiteral = `[${embedding.join(',')}]`;

    const schema = process.env.MANUAL_SCHEMA || 'public';
    const table  = process.env.MANUAL_TABLE  || 'manual_chunks';
    const map = await getColumnMapping(schema, table);

    // Bygg SELECT-delen dynamiskt. Valfria fält ersätts med NULL om de saknas.
    const selects = [
      map.docIdCol   ? `${id(map.docIdCol)} AS doc_id` : `NULL AS doc_id`,
      map.titleCol   ? `${id(map.titleCol)} AS title`  : `NULL AS title`,
      map.idxCol     ? `${id(map.idxCol)} AS idx`      : `NULL AS idx`,
      map.headingCol ? `${id(map.headingCol)} AS heading` : `NULL AS heading`,
      `${id(map.textCol)} AS chunk`,
      `1 - (${id(map.embCol)} <=> (SELECT emb FROM q)) AS score`
    ].join(',\n       ');

    const sql = `
      WITH q AS (SELECT $1::vector AS emb)
      SELECT ${selects}
      FROM ${id(schema)}.${id(table)}
      WHERE 1 - (${id(map.embCol)} <=> (SELECT emb FROM q)) >= $3
      ORDER BY ${id(map.embCol)} <-> (SELECT emb FROM q)
      LIMIT $2
    `;

    let rows;
    try {
      const r = await pool.query(sql, [vecLiteral, K, minScore]);
      rows = r.rows || [];
    } catch (dbErr) {
      const msg = String(dbErr?.message || dbErr);
      if (msg.includes('<->') || msg.includes('<=>')) {
        throw new Error('pgvector saknas eller är inte aktiverat. Kör: CREATE EXTENSION IF NOT EXISTS vector;');
      }
      if (msg.includes('dimension mismatch')) {
        throw new Error('Dimensionsfel: kolumnens vektordimension matchar inte embedding-modellen (text-embedding-3-small = vector(1536)).');
      }
      throw dbErr;
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      count: rows.length,
      model, dims,
      snippets: rows.map(r => ({
        doc_id: r.doc_id ?? null,
        title:  r.title ?? null,
        idx:    r.idx ?? null,
        heading:r.heading ?? null,
        score:  Number((r.score ?? 0).toFixed(4)),
        text:   r.chunk
      }))
    }));
  } catch (err) {
    console.error('search-manual 500', err);
    res.status(500).end(JSON.stringify({ ok:false, error: err?.message || String(err) }));
  }
}
