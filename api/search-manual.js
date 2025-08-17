// /api/search-manual.js
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

const id = s => `"${String(s).replace(/"/g,'""')}"`;

function readJsonBody(req){
  try{ if(!req.body) return {}; if(typeof req.body==='string') return JSON.parse(req.body); return req.body; }
  catch{ return {}; }
}

async function embedQuery(q){
  if(!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY saknas (env)');
  const model = process.env.EMBED_MODEL || 'text-embedding-3-small'; // 1536
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method:'POST',
    headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ model, input: q })
  });
  if(!r.ok){ const t = await r.text(); throw new Error(`OpenAI embeddings misslyckades: ${r.status} ${r.statusText} – ${t.slice(0,200)}`); }
  const j = await r.json();
  const emb = j.data?.[0]?.embedding;
  if(!emb) throw new Error('Embedding saknas i OpenAI-svar');
  return { embedding: emb, model, dims: emb.length };
}

async function columns(schema, table){
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`,
    [schema, table]
  );
  return rows.map(r => r.column_name);
}
async function tableExists(schema, table){
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2`,
    [schema, table]
  );
  return rows.length>0;
}

async function getMappings(){
  const schema      = process.env.MANUAL_SCHEMA || 'public';
  const chunksTable = process.env.MANUAL_TABLE  || 'manual_chunks';
  const docsTable   = process.env.MANUAL_DOCS_TABLE || 'manual_docs';

  const chunkCols = await columns(schema, chunksTable);
  const pick = (envName, cands) => {
    const v = process.env[envName];
    if (v && chunkCols.includes(v)) return v;
    return cands.find(c => chunkCols.includes(c));
  };

  const textCol    = pick('MANUAL_TEXT_COL', ['chunk','content','text','body','raw','paragraph']);
  const embCol     = pick('MANUAL_EMB_COL',  ['embedding','vector','emb','embedding_1536','embed']);
  const idxCol     = pick('MANUAL_IDX_COL',  ['idx','chunk_index','position','ord','i']);
  const headingCol = pick('MANUAL_HEADING_COL', ['heading','section','h1','h2']);
  const docIdCol   = pick('MANUAL_DOCID_COL', ['doc_id','document_id','docid','source_id','doc']);

  if(!textCol) throw new Error('Kunde inte hitta textkolumn i manual_chunks (provat: chunk/content/text/body/raw/paragraph). Sätt MANUAL_TEXT_COL.');
  if(!embCol)  throw new Error('Kunde inte hitta embedding-kolumn i manual_chunks (provat: embedding/vector/emb/embedding_1536/embed). Sätt MANUAL_EMB_COL.');

  let join = { exists:false };
  if (await tableExists(schema, docsTable)) {
    const docsCols = await columns(schema, docsTable);
    const pickDocs = (envName, cands) => {
      const v = process.env[envName];
      if (v && docsCols.includes(v)) return v;
      return cands.find(c => docsCols.includes(c));
    };
    const docsIdCol    = pickDocs('MANUAL_DOCS_ID_COL',    ['doc_id','id','document_id','docid','source_id']);
    const docsTitleCol = pickDocs('MANUAL_DOCS_TITLE_COL', ['title','name','doc_title']);
    if (docsIdCol) join = { exists:true, schema, table:docsTable, idCol:docsIdCol, titleCol:docsTitleCol||null };
  }

  return { schema, chunksTable, textCol, embCol, idxCol, headingCol, docIdCol, join };
}

function buildSQL(map, filtered){
  const sel = [];
  sel.push(map.join.exists ? (map.join.titleCol ? `d.${id(map.join.titleCol)} AS title` : `NULL AS title`) : `NULL AS title`);
  sel.push(map.docIdCol ? `c.${id(map.docIdCol)} AS doc_id` : `NULL AS doc_id`);
  sel.push(map.idxCol ? `c.${id(map.idxCol)} AS idx` : `NULL AS idx`);
  sel.push(map.headingCol ? `c.${id(map.headingCol)} AS heading` : `NULL AS heading`);
  sel.push(`c.${id(map.textCol)} AS chunk`);
  sel.push(`1 - (c.${id(map.embCol)} <=> (SELECT emb FROM q)) AS score`);

  const fromJoin = map.join.exists && map.docIdCol
    ? `FROM ${id(map.schema)}.${id(map.chunksTable)} c
       LEFT JOIN ${id(map.join.schema)}.${id(map.join.table)} d
         ON d.${id(map.join.idCol)} = c.${id(map.docIdCol)}`
    : `FROM ${id(map.schema)}.${id(map.chunksTable)} c`;

  const where = filtered
    ? `WHERE 1 - (c.${id(map.embCol)} <=> (SELECT emb FROM q)) >= $3`
    : ``;

  return `
    WITH q AS (SELECT $1::vector AS emb)
    SELECT ${sel.join(',\n           ')}
    ${fromJoin}
    ${where}
    ORDER BY c.${id(map.embCol)} <-> (SELECT emb FROM q)
    LIMIT $2
  `;
}

export default async function handler(req,res){
  res.setHeader('Content-Type','application/json');
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ok:false,error:'Method not allowed'}));

  try{
    const body = readJsonBody(req);
    const query = String((body.query||'')).trim();
    if (!query) return res.status(400).end(JSON.stringify({ok:false,error:'Missing query'}));
    const K = Number(body.k ?? body.topK ?? 5);
    const minScore = Number(body.minSim ?? 0);

    const { embedding, model, dims } = await embedQuery(query);
    const vecLiteral = `[${embedding.join(',')}]`;

    const map = await getMappings();

    // 1) Försök med filter
    let sql = buildSQL(map, true);
    let rows;
    try{
      const r = await pool.query(sql, [vecLiteral, K, minScore]);
      rows = r.rows || [];
    } catch (dbErr){
      const msg = String(dbErr?.message || dbErr);
      if (msg.includes('<->') || msg.includes('<=>')) throw new Error('pgvector saknas/ej aktiverad. Kör: CREATE EXTENSION IF NOT EXISTS vector;');
      if (msg.includes('dimension mismatch')) throw new Error('Dimensionsfel: vektordimension matchar inte modellen (text-embedding-3-small = vector(1536)).');
      throw dbErr;
    }

    let fallback = false;
    if (rows.length === 0) {
      // 2) Fallback utan WHERE (visa topp-K oavsett score)
      fallback = true;
      sql = buildSQL(map, false);
      const r2 = await pool.query(sql, [vecLiteral, K]);
      rows = r2.rows || [];
    }

    res.status(200).end(JSON.stringify({
      ok:true, count: rows.length, model, dims, fallback,
      snippets: rows.map(r => ({
        doc_id:  r.doc_id ?? null,
        title:   r.title ?? null,
        idx:     r.idx ?? null,
        heading: r.heading ?? null,
        score:   Number((r.score ?? 0).toFixed(4)),
        text:    r.chunk
      }))
    }));
  }catch(err){
    console.error('search-manual 500', err);
    res.status(500).end(JSON.stringify({ ok:false, error: err?.message || String(err) }));
  }
}
