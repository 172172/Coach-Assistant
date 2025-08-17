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
  try{
    if(!req.body) return {};
    if(typeof req.body==='string') return JSON.parse(req.body);
    return req.body;
  }catch{
    return {};
  }
}

async function embedQuery(q){
  if(!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY saknas (env)');
  const model = process.env.EMBED_MODEL || 'text-embedding-3-small'; // dims 1536
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method:'POST',
    headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ model, input: q })
  });
  if(!r.ok){
    const t = await r.text();
    throw new Error(`OpenAI embeddings misslyckades: ${r.status} ${r.statusText} – ${t.slice(0,200)}`);
  }
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
  const headingCol = pick('MANUAL_HEADING_COL', ['heading','section','h1','h2','rubrik']);
  const hPathCol   = pick('MANUAL_HPATH_COL',   ['h_path','path','section_path','heading_path','hpath']); // valfri "rubrikstig"
  const tsvCol     = pick('MANUAL_TSV_COL',     ['tsv','text_tsv','search_tsv','ts']); // valfri pre-beräknad tsvector
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

  return { schema, chunksTable, textCol, embCol, idxCol, headingCol, hPathCol, tsvCol, docIdCol, join };
}

// Bygger ett heading-matchuttryck beroende på vilka kolumner som faktiskt finns
function headingMatchExpr(map){
  const parts=[];
  if (map.headingCol) parts.push(`LOWER(c.${id(map.headingCol)}) LIKE $5`);
  if (map.hPathCol)   parts.push(`LOWER(c.${id(map.hPathCol)}) LIKE $5`);
  if (map.join.exists && map.join.titleCol) parts.push(`LOWER(d.${id(map.join.titleCol)}) LIKE $5`);
  return parts.length ? `(${parts.join(' OR ')})` : `FALSE`;
}

// Hybrid-sökning: 1) ta topp-N på vektor (index) 2) reranka med ts_rank + heading-boost
function buildSQLHybrid(map, { filtered, restrictToHeading }){
  // Kolumnlistor
  const selBase = [
    map.join.exists ? (map.join.titleCol ? `d.${id(map.join.titleCol)} AS title` : `NULL AS title`) : `NULL AS title`,
    map.docIdCol ? `c.${id(map.docIdCol)} AS doc_id` : `NULL AS doc_id`,
    map.idxCol ? `c.${id(map.idxCol)} AS idx` : `NULL AS idx`,
    map.headingCol ? `c.${id(map.headingCol)} AS heading` : `NULL AS heading`,
    map.hPathCol ? `c.${id(map.hPathCol)} AS h_path` : `NULL AS h_path`,
    `c.${id(map.textCol)} AS chunk`,
    // vec_score separat i kandidater
    `1 - (c.${id(map.embCol)} <=> (SELECT emb FROM q)) AS vec_score`
  ];

  const fromJoin = map.join.exists && map.docIdCol
    ? `FROM ${id(map.schema)}.${id(map.chunksTable)} c
       LEFT JOIN ${id(map.join.schema)}.${id(map.join.table)} d
         ON d.${id(map.join.idCol)} = c.${id(map.docIdCol)}`
    : `FROM ${id(map.schema)}.${id(map.chunksTable)} c`;

  const headingExpr = headingMatchExpr(map);

  // WHERE-del i kandidat-steget
  const whereParts = [];
  if (filtered){
    // minSim ($3) används på vec_score
    whereParts.push(`1 - (c.${id(map.embCol)} <=> (SELECT emb FROM q)) >= $3`);
  }
  // headingberoende filter
  // $5 = heading LIKE-mönster, t.ex. '%sortbyte%'
  if (restrictToHeading){
    // hårt filter om $5 finns, annars inga heading-krav
    whereParts.push(`($5 IS NULL OR ${headingExpr})`);
  } else {
    // mjukt: inga krav i kandidatsteget (vi boostar i reranking), men behåller optional guard om $5 är NULL
    // (dvs lägg inte till något, för indexvänlig kandidatinsamling)
  }
  const whereSQL = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ``;

  // tsvector-uttryck (precompute-kolumn om finns, annars on-the-fly)
  const tsvExpr = map.tsvCol
    ? `c.${id(map.tsvCol)}`
    : `to_tsvector('simple', c.${id(map.textCol)})`;

  // Huvud-sql:
  // $1: emb vector
  // $2: slutligt LIMIT K
  // $3: minScore (vec)
  // $4: qtext (för tsquery)
  // $5: headingLike (t.ex. %sortbyte%)
  // $6: candidateK (hur många topp-vec innan rerank)
  return `
    WITH
      q AS (SELECT $1::vector AS emb),
      t AS (SELECT $4::text AS qtext, plainto_tsquery('simple', $4::text) AS tsq),
      cand AS (
        SELECT
          ${selBase.join(',\n          ')}
        ${fromJoin}
        ${whereSQL}
        ORDER BY c.${id(map.embCol)} <-> (SELECT emb FROM q)
        LIMIT $6
      )
    SELECT
      title, doc_id, idx, heading, h_path, chunk,
      -- clampa ts_rank och räkna slutscore (0..1)
      vec_score,
      LEAST(ts_rank_cd(${tsvExpr}, (SELECT tsq FROM t)), 1.0) AS ts_score,
      CASE WHEN ${headingExpr.replaceAll('c.', 'cand.').replaceAll('d.', 'cand.')} THEN 0.08 ELSE 0.0 END AS heading_boost,
      ROUND( (0.75*vec_score + 0.23*LEAST(ts_rank_cd(${tsvExpr.replaceAll('c.', 'cand.')}, (SELECT tsq FROM t)),1.0) + 
             CASE WHEN ${headingExpr.replaceAll('c.', 'cand.').replaceAll('d.', 'cand.')} THEN 0.02 ELSE 0.0 END)::numeric, 6) AS score
    FROM cand
    ORDER BY score DESC
    LIMIT $2
  `;
}

// Fallback (enkel vektor-rank, din gamla väg)
function buildSQLVectorOnly(map, { filtered }){
  const sel = [];
  sel.push(map.join.exists ? (map.join.titleCol ? `d.${id(map.join.titleCol)} AS title` : `NULL AS title`) : `NULL AS title`);
  sel.push(map.docIdCol ? `c.${id(map.docIdCol)} AS doc_id` : `NULL AS doc_id`);
  sel.push(map.idxCol ? `c.${id(map.idxCol)} AS idx` : `NULL AS idx`);
  sel.push(map.headingCol ? `c.${id(map.headingCol)} AS heading` : `NULL AS heading`);
  sel.push(map.hPathCol ? `c.${id(map.hPathCol)} AS h_path` : `NULL AS h_path`);
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
    const headingRaw = (body.heading ?? '').toString().trim();
    const heading = headingRaw ? headingRaw.toLowerCase() : null;
    const restrictToHeading = Boolean(body.restrictToHeading ?? false);
    const candidateK = Math.max(30, Number(body.candidateK ?? (K*12))); // topp-N för rerank

    const { embedding, model, dims } = await embedQuery(query);
    const vecLiteral = `[${embedding.join(',')}]`;

    const map = await getMappings();

    // Förbered parametrar
    const params = [
      vecLiteral,     // $1 :: vector
      K,              // $2 :: final limit
      minScore,       // $3 :: minSim
      query,          // $4 :: qtext (tsquery)
      heading ? `%${heading}%` : null, // $5 :: heading LIKE
      candidateK      // $6 :: kandidat-limit
    ];

    let rows = [];
    let fallback = false;

    // 1) Hybrid med kandidat-rerank (filtrerad på minSim). Respektera restrictToHeading i kandidat WHERE.
    try{
      const sqlHybrid = buildSQLHybrid(map, { filtered:true, restrictToHeading });
      const r = await pool.query(sqlHybrid, params);
      rows = r.rows || [];
    }catch(dbErr){
      // Vanligaste felet: pgvector/tsvector saknas – vi faller tillbaka på enkel vektorväg
      // Det här bevarar din tidigare funktionalitet.
      const msg = String(dbErr?.message || dbErr);
      if (msg.includes('<->') || msg.includes('<=>')) throw new Error('pgvector saknas/ej aktiverad. Kör: CREATE EXTENSION IF NOT EXISTS vector;');
      if (msg.includes('dimension mismatch')) throw new Error('Dimensionsfel: vektordimension matchar inte modellen (text-embedding-3-small = vector(1536)).');
      // Annars försök vektor-only
      const sqlVec = buildSQLVectorOnly(map, { filtered:true });
      const r2 = await pool.query(sqlVec, [vecLiteral, K, minScore]);
      rows = r2.rows || [];
    }

    // 2) Fallbacks om tomt
    if (rows.length === 0){
      // 2a) Hybrid utan minSim (bredda) – respektera restrictToHeading
      try{
        const sqlHybridWide = buildSQLHybrid(map, { filtered:false, restrictToHeading });
        const rW = await pool.query(sqlHybridWide, params);
        rows = rW.rows || [];
      }catch{
        // 2b) Vektor-only utan minSim
        const sqlVecWide = buildSQLVectorOnly(map, { filtered:false });
        const r2 = await pool.query(sqlVecWide, [vecLiteral, K]);
        rows = r2.rows || [];
      }
      fallback = true;
    }

    // 3) Om användaren krävde heading och vi fortfarande inte hittar något – returnera tomt (ingen "tvingad" fallback till andra ämnen)
    if (restrictToHeading && (heading?.length>0) && rows.length===0){
      return res.status(200).end(JSON.stringify({
        ok:true, count: 0, model, dims, fallback: false, // medvetet false: vi valde att inte lämna ämnet
        snippets: []
      }));
    }

    // 4) Svar
    res.status(200).end(JSON.stringify({
      ok:true,
      count: rows.length,
      model, dims,
      fallback,
      snippets: rows.map(r => ({
        doc_id:  r.doc_id ?? null,
        title:   r.title ?? null,
        idx:     r.idx ?? null,
        heading: r.heading ?? null,
        h_path:  r.h_path ?? null,
        score:   Number((r.score ?? r.vec_score ?? 0).toFixed(4)),
        text:    r.chunk
      }))
    }));
  }catch(err){
    console.error('search-manual 500', err);
    res.status(500).end(JSON.stringify({ ok:false, error: err?.message || String(err) }));
  }
}
