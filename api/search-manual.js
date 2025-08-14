// /api/search-manual.js  (ESM, Node 20, autodetect + optional join mot manual_docs)
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

const id = (s) => `"${String(s).replace(/"/g, '""')}"`;

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
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI embeddings misslyckades: ${r.status} ${r.statusText} – ${t.slice(0,200)}`);
  }
  const j = await r.json();
  const emb = j.data?.[0]?.embedding;
  if (!emb) throw new Error('Embedding saknas i OpenAI-svar');
  return { embedding: emb, model, dims: emb.length };
}

async function getColumns(schema, table) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`,
    [schema, table]
  );
  return rows.map(r => r.column_name);
}

async function tableExists(schema, table) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2`,
    [schema, table]
  );
  return rows.length > 0;
}

async function getMappings() {
  const schema      = process.env.MANUAL_SCHEMA || 'public';
  const chunksTable = process.env.MANUAL_TABLE  || 'manual_chunks';
  const docsTable   = process.env.MANUAL_DOCS_TABLE || 'manual_docs';

  const chunkCols = await getColumns(schema, chunksTable);

  const envPick = (envName, candidates) => {
    const v = process.env[envName];
    if (v && chunkCols.includes(v)) return v;
    return candidates.find(c => chunkCols.includes(c));
  };

  // Obligatoriskt i chunks:
  const textCol = envPick('MANUAL_TEXT_COL', ['chunk','content','text','body','raw','paragraph']);
  const embCol  = envPick('MANUAL_EMB_COL',  ['embedding','vector','emb','embedding_1536','embed']);

  if (!textCol) throw new Error('Kunde inte hitta textkolumn i manual_chunks (provat: chunk/content/text/body/raw/paragraph). Sätt MANUAL_TEXT_COL.');
  if (!embCol)  throw new Error('Kunde inte hitta embedding-kolumn i manual_chunks (provat: embedding/vector/emb/embedding_1536/embed). Sätt MANUAL_EMB_COL.');

  // Valfria i chunks:
  const idxCol     = envPick('MANUAL_IDX_COL',     ['idx','chunk_index','position','ord','i']);
  const headingCol = envPick('MANUAL_HEADING_COL', ['heading','section','h1','h2']);
  const docIdCol   = envPick('MANUAL_DOCID_COL',   ['doc_id','document_id','docid','source_id','doc']);

  // Docs-join (valfritt)
  let join = { exists:false };
  if (await tableExists(schema, docsTable)) {
    const docsCols = await getColumns(schema, docsTable);
    const pick = (cands, env) => {
      const v = process.env[env];
      if (v && docsCols.includes(v)) return v;
      return cands.find(c => docsCols.includes(c));
    };
    const docsIdCol    = pick(['doc_id','id','document_id','docid','source_id'], 'MANUAL_DOCS_ID_COL');
    const docsTitleCol = pick(['title','name','doc_title'], 'MANUAL_DOCS_TITLE_COL');
    if (docsIdCol) {
      join = {
        exists: true, schema, table: docsTable,
        idCol: docsIdCol, titleCol: docsTitleCol || null
      };
    }
  }

  return {
    schema, chunksTable, textCol, embCol, idxCol, headingCol, docIdCol, join
  };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).end(JSON.stringify({ ok:false, error:'Method not allowed' })); return;
  }

  try {
    const body = readJsonBody(req);
    const query = String((body.query || '')).trim();
    if (!query) return res.status(400).end(JSON.stringify({ ok:false, error:'Missing query' }));

    const K        = Number(body.k ?? body.topK ?? 5);
    const minScore = Number(body.minSim ?? 0);

    const { embedding, model, dims } = await embedQuery(query);
    const vecLiteral = `[${embedding.join(',')}]`;

    const m = await getMappings();

    // SELECT-del med optional LEFT JOIN mot docs för title
    const selectPieces = [
      m.docIdCol   ? `c.${id(m.docIdCol)} AS doc_id` : `NULL AS doc_id`,
      m.idxCol     ? `c.${id(m.idxCol)} AS idx`      : `NULL AS idx`,
      m.headingCol ? `c.${id(m.headingCol)} AS heading` : `NULL AS heading`,
      `c.${id(m.textCol)} AS chunk`,
      `1 - (c.${id(m.embCol)} <=> (SELECT emb FROM q)) AS score`
    ];
    if (m.join.exists) {
      selectPieces.unshift(
        m.join.titleCol ? `d.${id(m.join.titleCol)} AS title` : `NULL AS title`
      );
    } else {
      selectPieces.unshift(`NULL AS title`);
    }

    const fromJoin = m.join.exists && m.docIdCol
      ? `FROM ${id(m.schema)}.${id(m.chunksTable)} c
         LEFT JOIN ${id(m.join.schema)}.${id(m.join.table)} d
         ON d.${id(m.join.idCol)} = c.${id(m.docIdCol)}`
      : `FROM ${id(m.schema)}.${id(m.chunksTable)} c`;

    const sql = `
      WITH q AS (SELECT $1::vector AS emb)
      SELECT ${selectPieces.join(',\n             ')}
      ${fromJoin}
      WHERE 1 - (c.${id(m.embCol)} <=> (SELECT emb FROM q)) >= $3
      ORDER BY c.${id(m.embCol)} <-> (SELECT emb FROM q)
      LIMIT $2
    `;

    let rows;
    try {
      const r = await pool.query(sql, [vecLiteral, K, minScore]);
      rows = r.rows || [];
    } catch (dbErr) {
      const msg = String(dbErr?.message || dbErr);
      if (msg.includes('<->') || msg.includes('<=>'))
        throw new Error('pgvector saknas/ej aktiverad. Kör: CREATE EXTENSION IF NOT EXISTS vector;');
      if (msg.includes('dimension mismatch'))
        throw new Error('Dimensionsfel: kolumnens vektor-dimension matchar inte embedding-modellen (text-embedding-3-small = vector(1536)).');
      throw dbErr;
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      count: rows.length,
      model, dims,
      snippets: rows.map(r => ({
        doc_id:  r.doc_id ?? null,
        title:   r.title ?? null,
        idx:     r.idx ?? null,
        heading: r.heading ?? null,
        score:   Number((r.score ?? 0).toFixed(4)),
        text:    r.chunk
      }))
    }));
  } catch (err) {
    console.error('search-manual 500', err);
    res.status(500).end(JSON.stringify({ ok:false, error: err?.message || String(err) }));
  }
}
