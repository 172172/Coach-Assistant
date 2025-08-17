// /api/search-manual.js
// Hybrid-sök för manualen: embeddings + Postgres fulltext + heading-filter + "must"-termer + granne-expansion.
// Kräver pgvector. Rekommenderat: aktivera även pg_trgm (valfritt).
//
// Tips (kör en gång i databasen):
//   CREATE EXTENSION IF NOT EXISTS vector;
//   CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- valfritt men ger bättre fuzzy-lexikalt

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
  }catch{ return {}; }
}

async function embedQuery(q){
  if(!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY saknas (env)');
  const model = process.env.EMBED_MODEL || 'text-embedding-3-small'; // 1536
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
  const headingCol = pick('MANUAL_HEADING_COL', ['heading','section','h1','h2','h_path','path']);
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

function buildHybridSQL(map, opts){
  const {
    filtered,           // bool: använd minSim-filter
    useLex,             // bool: med fulltext rank
    heading,            // string|null
    restrictToHeading,  // bool
    mustTokens          // array<string>
  } = opts;

  // SELECT list
  const sel = [];
  sel.push(map.join.exists ? (map.join.titleCol ? `d.${id(map.join.titleCol)} AS title` : `NULL AS title`) : `NULL AS title`);
  sel.push(map.docIdCol ? `c.${id(map.docIdCol)} AS doc_id` : `NULL AS doc_id`);
  sel.push(map.idxCol ? `c.${id(map.idxCol)} AS idx` : `NULL AS idx`);
  sel.push(map.headingCol ? `c.${id(map.headingCol)} AS heading` : `NULL AS heading`);
  sel.push(`c.${id(map.textCol)} AS chunk`);

  const vecSim = `1 - (c.${id(map.embCol)} <=> (SELECT emb FROM q))`; // 0..1
  const lexRank = useLex ? `ts_rank(to_tsvector('simple', c.${id(map.textCol)}), plainto_tsquery('simple', $4))` : `0`;

  // extra boost om heading/titel matchar
  const headingLike = heading ? `(
      lower(c.${id(map.headingCol)}) like lower($5)
      OR ${map.join.exists && map.join.titleCol ? `lower(d.${id(map.join.titleCol)}) like lower($5)` : `false`}
    )` : `false`;

  const headBoost = heading ? `CASE WHEN ${headingLike} THEN 0.12 ELSE 0 END` : `0`;

  // slutscore
  sel.push(`${vecSim} AS vec_score`);
  sel.push(`${useLex ? lexRank : '0'} AS lex_score`);
  sel.push(`${vecSim}*0.75 + (${useLex ? lexRank : '0'})*0.25 + ${headBoost} AS score`);

  // FROM
  const fromJoin = map.join.exists && map.docIdCol
    ? `FROM ${id(map.schema)}.${id(map.chunksTable)} c
       LEFT JOIN ${id(map.join.schema)}.${id(map.join.table)} d
         ON d.${id(map.join.idCol)} = c.${id(map.docIdCol)}`
    : `FROM ${id(map.schema)}.${id(map.chunksTable)} c`;

  // WHERE
  const where = [];
  if (filtered) where.push(`${vecSim} >= $3`);

  // heading-lås
  if (heading && restrictToHeading){
    const like = `lower($5)`;
    const conds = [];
    if (map.headingCol) conds.push(`lower(c.${id(map.headingCol)}) like ${like}`);
    if (map.join.exists && map.join.titleCol) conds.push(`lower(d.${id(map.join.titleCol)}) like ${like}`);
    if (conds.length) where.push(`(${conds.join(' OR ')})`);
  }

  // must-termer (enkelt ILIKE OCH-villkor)
  // Läggs som: (c.text ILIKE $N OR c.heading ILIKE $N OR d.title ILIKE $N)
  const mustClauses = [];
  (mustTokens||[]).forEach((_,i)=>{
    const p = `$${6+i}`; // efter $1:$5
    const parts = [`c.${id(map.textCol)} ILIKE ${p}`];
    if (map.headingCol) parts.push(`c.${id(map.headingCol)} ILIKE ${p}`);
    if (map.join.exists && map.join.titleCol) parts.push(`d.${id(map.join.titleCol)} ILIKE ${p}`);
    mustClauses.push(`(${parts.join(' OR ')})`);
  });
  if (mustClauses.length) where.push(mustClauses.join(' AND '));

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : ``;

  return `
    WITH q AS (SELECT $1::vector AS emb)
    SELECT ${sel.join(',\n           ')}
    ${fromJoin}
    ${whereSQL}
    ORDER BY score DESC
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

    const K = Math.max(1, Number(body.k ?? body.topK ?? 5));
    const minScore = Number(body.minSim ?? 0);
    const heading  = (body.heading ?? null) ? String(body.heading).trim() : null;
    const restrictToHeading = !!body.restrictToHeading;
    const mustTokens = Array.isArray(body.must) ? body.must.filter(Boolean).map(String) : [];
    const expandNeighbours = Math.max(0, Number(body.expandNeighbours ?? 1)); // hur många chunk åt varje håll

    const { embedding, model, dims } = await embedQuery(query);
    const vecLiteral = `[${embedding.join(',')}]`;

    const map = await getMappings();

    // 1) Hybrid med minSim + lex
    let sql = buildHybridSQL(map, {
      filtered: true, useLex: true,
      heading, restrictToHeading, mustTokens
    });

    const params = [vecLiteral, K, minScore];
    // $4 = plainto_tsquery text
    params.push(query);
    // $5 = heading pattern  (om ej används → sätt något)
    params.push(heading ? `%${heading}%` : `%`);
    // $6.. = must tokens som %tok%
    mustTokens.forEach(tok => params.push(`%${tok}%`));

    let rows;
    try{
      const r = await pool.query(sql, params);
      rows = r.rows || [];
    } catch (dbErr){
      const msg = String(dbErr?.message || dbErr);
      if (msg.includes('<->') || msg.includes('<=>')) throw new Error('pgvector saknas/ej aktiverad. Kör: CREATE EXTENSION IF NOT EXISTS vector;');
      if (msg.includes('dimension mismatch')) throw new Error('Dimensionsfel: vektordimension matchar inte modellen (text-embedding-3-small = vector(1536)).');
      // Om ts_rank/plainto_tsquery skulle saknas i setup → kör om utan lex
      sql = buildHybridSQL(map, { filtered:true, useLex:false, heading, restrictToHeading, mustTokens });
      const r2 = await pool.query(sql, [vecLiteral, K, minScore, query, heading ? `%${heading}%` : `%`, ...mustTokens.map(t=>`%${t}%`)]);
      rows = r2.rows || [];
    }

    let fallback = false;
    if (rows.length === 0) {
      // 2) Fallback utan minSim, men behåll heading/must
      fallback = true;
      sql = buildHybridSQL(map, { filtered:false, useLex:true, heading, restrictToHeading, mustTokens });
      const r2 = await pool.query(sql, [vecLiteral, K, 0, query, heading ? `%${heading}%` : `%`, ...mustTokens.map(t=>`%${t}%`)]);
      rows = r2.rows || [];
    }

    // 3) Grann-expansion (±N chunks) för att få hel mening, om idx & doc_id finns
    if (expandNeighbours>0 && map.idxCol && map.docIdCol && rows.length){
      const uniq = new Map();
      for (const r of rows) uniq.set(`${r.doc_id}#${r.idx}`, r);
      const need = [];
      for (const r of rows){
        if (r.doc_id==null || r.idx==null) continue;
        for (let d=1; d<=expandNeighbours; d++){
          need.push({ doc_id: r.doc_id, idx: r.idx - d });
          need.push({ doc_id: r.doc_id, idx: r.idx + d });
        }
      }
      // batcha en sekundär query
      if (need.length){
        // bygg IN-lista
        const vals = [];
        const tuples = need.map((p,i)=> {
          vals.push(p.doc_id, p.idx);
          return `($${vals.length-1+1}, $${vals.length+0})`;
        });
        const q2 = `
          SELECT ${map.docIdCol ? `c.${id(map.docIdCol)} AS doc_id` : `NULL AS doc_id`},
                 ${map.idxCol ? `c.${id(map.idxCol)} AS idx` : `NULL AS idx`},
                 ${map.headingCol ? `c.${id(map.headingCol)} AS heading` : `NULL AS heading`},
                 c.${id(map.textCol)} AS chunk,
                 ${map.join.exists ? (map.join.titleCol ? `d.${id(map.join.titleCol)} AS title` : `NULL AS title`) : `NULL AS title`},
                 0.0 AS vec_score, 0.0 AS lex_score, 0.0 AS score
          FROM ${id(map.schema)}.${id(map.chunksTable)} c
          ${map.join.exists && map.docIdCol
            ? `LEFT JOIN ${id(map.join.schema)}.${id(map.join.table)} d ON d.${id(map.join.idCol)} = c.${id(map.docIdCol)}`
            : ``}
          WHERE (${map.docIdCol ? `c.${id(map.docIdCol)}` : 'NULL'}, ${map.idxCol ? `c.${id(map.idxCol)}` : 'NULL'}) IN (${tuples.join(',')})
        `;
        const r2 = await pool.query(q2, vals);
        for (const rr of (r2.rows||[])) uniq.set(`${rr.doc_id}#${rr.idx}`, rr);
      }
      rows = Array.from(uniq.values());
      // Behåll topp K först i ordning score DESC, sedan grannar efter doc/idx
      rows.sort((a,b)=> (Number(b.score??0) - Number(a.score??0)) || (Number(a.doc_id??0)-Number(b.doc_id??0)) || (Number(a.idx??0)-Number(b.idx??0)));
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
