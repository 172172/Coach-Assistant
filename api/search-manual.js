// /api/search-manual.js – v4 (ren JS) — HYBRID PERSONSÖK (lika stabilt som ChatGPT på namn)
// Nytt i v4:
//  - Person-index från manualen (rubriker som innehåller "personal")
//  - Kanonisering av namn (Oskar ↔ Oscar, ph→f, ck→k, c→k/s efter vokal)
//  - Fuzzy-match (Levenshtein-ratio) + trigram-Jaccard
//  - Hybrid: 1) Lexikal personsök, 2) Embedding med rubrikfilter, 3) Fallback breddning
//  - Extra debug-fält

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
  try { if (!req.body) return {}; if (typeof req.body === 'string') return JSON.parse(req.body); return req.body; }
  catch { return {}; }
}
function quoteIdent(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }

async function embedQuery(q) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY saknas (env)');
  const model = process.env.EMBED_MODEL || 'text-embedding-3-small'; // 1536-dim
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: q }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI embeddings misslyckades: ${r.status} ${r.statusText} – ${t.slice(0,200)}`); }
  const j = await r.json(); const emb = j.data && j.data[0] && j.data[0].embedding;
  if (!emb) throw new Error('Embedding saknas i OpenAI-svar'); return { embedding: emb, model, dims: emb.length };
}

async function tableExists(schema, table) {
  const { rows } = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2 LIMIT 1`, [schema, table]);
  return rows.length > 0;
}
async function columns(schema, table) {
  const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`, [schema, table]);
  return rows.map((r) => r.column_name);
}

async function getMappings() {
  const schema = process.env.MANUAL_SCHEMA || 'public';
  const chunksTable = process.env.MANUAL_TABLE || 'manual_chunks';
  const docsTable = process.env.MANUAL_DOCS_TABLE || 'manual_docs';

  const chunkCols = await columns(schema, chunksTable);
  const pick = (envName, cands) => { const v = process.env[envName]; if (v && chunkCols.includes(v)) return v; return cands.find((c) => chunkCols.includes(c)); };

  const textCol    = pick('MANUAL_TEXT_COL',    ['chunk','content','text','body','raw','paragraph']);
  const embCol     = pick('MANUAL_EMB_COL',     ['embedding','vector','emb','embedding_1536','embed']);
  const idxCol     = pick('MANUAL_IDX_COL',     ['idx','chunk_index','position','ord','i']);
  const headingCol = pick('MANUAL_HEADING_COL', ['heading','section','h1','h2']);
  const docIdCol   = pick('MANUAL_DOCID_COL',   ['doc_id','document_id','docid','source_id','doc']);

  if (!textCol) throw new Error('Kunde inte hitta textkolumn i manualtabellen … Sätt MANUAL_TEXT_COL.');
  if (!embCol)  throw new Error('Kunde inte hitta embedding-kolumn … Sätt MANUAL_EMB_COL.');

  let join = { exists: false };
  if (await tableExists(schema, docsTable)) {
    const docsCols = await columns(schema, docsTable);
    const pickDocs = (envName, cands) => { const v = process.env[envName]; if (v && docsCols.includes(v)) return v; return cands.find((c) => docsCols.includes(c)); };
    join = { exists: true, schema, table: docsTable,
      idCol: pickDocs('MANUAL_DOCS_ID_COL', ['id','doc_id','document_id','docid']),
      titleCol: pickDocs('MANUAL_DOCS_TITLE_COL', ['title','name','doc_title']),
    };
  }
  return { schema, chunksTable, textCol, embCol, idxCol, headingCol, docIdCol, join };
}

// ---- Rubrik-normalisering + personindex ----
let __knownHeadings = null;
let __peopleIndex   = null; // { nameKey -> [{ name, idx, heading, doc_id, text }] }

function stripDiacritics(s){ return s.normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function canonName(s){
  if (!s) return '';
  let t = stripDiacritics(String(s).toLowerCase());
  t = t.replace(/ph/g,'f').replace(/ck/g,'k');
  t = t.replace(/c([aouåäö])/g, 'k$1');   // c→k före a o u å ä ö  (Oscar→Oskar)
  t = t.replace(/c([eiy])/g,  's$1');     // c→s före e i y
  t = t.replace(/[^a-z0-9]+/g,'');        // ta bort mellanslag/-
  return t;
}
function levenRatio(a,b){ if (a===b) return 1; const la=a.length, lb=b.length; if (!la||!lb) return 0;
  const dp=Array.from({length:la+1},(_,i)=>Array(lb+1).fill(0)); for(let i=0;i<=la;i++) dp[i][0]=i; for(let j=0;j<=lb;j++) dp[0][j]=j;
  for(let i=1;i<=la;i++){ for(let j=1;j<=lb;j++){ const c=a[i-1]===b[j-1]?0:1; dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+c);} }
  return 1 - dp[la][lb] / Math.max(la,lb);
}
function trigrams(s){ const g=[]; for(let i=0;i<s.length-2;i++) g.push(s.slice(i,i+3)); return new Set(g); }
function jaccard(a,b){ const A=trigrams(a),B=trigrams(b); let inter=0; for(const x of A) if(B.has(x)) inter++; const uni=A.size+B.size-inter; return uni?inter/uni:0; }

async function getKnownHeadings(schema, table, headingCol) {
  if (__knownHeadings) return __knownHeadings;
  if (!headingCol) { __knownHeadings = []; return __knownHeadings; }
  const q = `
    SELECT DISTINCT LOWER(${quoteIdent(headingCol)}) AS h
    FROM ${quoteIdent(schema)}.${quoteIdent(table)}
    WHERE ${quoteIdent(headingCol)} IS NOT NULL AND ${quoteIdent(headingCol)} <> ''
    LIMIT 1000
  `;
  const { rows } = await pool.query(q);
  __knownHeadings = rows.map(r => String(r.h).trim()).filter(Boolean);
  return __knownHeadings;
}
function normalizeHeading(raw, known) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/["'`]/g,'').trim(); if (!s) return null;
  for (const h of known) if (s.includes(h)) return h;
  const toks = s.split(/[^a-zåäö0-9]+/i).filter(w => w.length>2);
  let best=null,bestScore=0;
  for (const h of known) {
    const hs=h.split(/[^a-zåäö0-9]+/i);
    const ov=hs.reduce((a,w)=>a+(toks.includes(w)?1:0),0);
    if (ov>bestScore){ best=h; bestScore=ov; }
  }
  return bestScore>0?best:null;
}

async function buildPeopleIndex(map){
  if (__peopleIndex) return __peopleIndex;
  __peopleIndex = Object.create(null);
  const whereHead = map.headingCol ? `LOWER(${quoteIdent(map.headingCol)}) LIKE '%personal%'` : 'TRUE';
  const q = `
    SELECT ${map.docIdCol? 'c.'+quoteIdent(map.docIdCol)+' AS doc_id,' : '' }
           ${map.idxCol? 'c.'+quoteIdent(map.idxCol)+' AS idx,'         : 'NULL AS idx,'}
           ${map.headingCol? 'LOWER(c.'+quoteIdent(map.headingCol)+') AS heading,' : `'`+`' AS heading,`}
           c.${quoteIdent(map.textCol)} AS chunk
    FROM ${quoteIdent(map.schema)}.${quoteIdent(map.chunksTable)} c
    WHERE ${whereHead}
    LIMIT 2000
  `;
  const { rows } = await pool.query(q);

  const rxName = /\b([A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+)+)\b/g;
  for (const r of rows){
    const text = String(r.chunk||''); rxName.lastIndex = 0; let m;
    while ((m = rxName.exec(text))){
      const name = m[1].trim();
      if (name.split(/\s+/).length>=2 || /\b(oscar|oskar|tobias|jonas|thomas|gezim)\b/i.test(name)){
        const key = canonName(name);
        if (!__peopleIndex[key]) __peopleIndex[key] = [];
        __peopleIndex[key].push({ name, idx: r.idx, heading: r.heading || null, doc_id: r.doc_id || null, text });
      }
    }
  }
  return __peopleIndex;
}
function bestPersonMatch(index, queryName){
  const keyQ = canonName(queryName);
  let best=null, bestScore=0;
  for (const [k, entries] of Object.entries(index)){
    const lr = levenRatio(keyQ, k);
    const jc = jaccard(keyQ, k);
    const score = 0.7*lr + 0.3*jc;
    if (score>bestScore){ bestScore=score; best={ score, entries }; }
  }
  return (best && bestScore>=0.72) ? best : null; // Oscar↔Oskar klaras
}

function buildSQL(map,{filtered,heading,restrict}){
  const sel=[]; 
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
  const where=[]; if (filtered) where.push(`1 - (c.${quoteIdent(map.embCol)} <=> (SELECT emb FROM q)) >= $3`);
  if (heading && restrict){
    const headCol = map.headingCol ? `c.${quoteIdent(map.headingCol)}` : `NULL`;
    const titleCol= map.join.exists && map.join.titleCol ? `d.${quoteIdent(map.join.titleCol)}` : `NULL`;
    const p = filtered?4:3; where.push(`(COALESCE(${headCol}, '') ILIKE $${p} OR COALESCE(${titleCol}, '') ILIKE $${p})`);
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
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ ok:false, error:'Method not allowed' }));
  try {
    const body = readJsonBody(req);
    const rawQ = (body.query || '').trim();
    const K = Math.min(Math.max(parseInt(body.k || body.topK || 5, 10) || 5, 1), 20);
    const minScore = typeof body.minSim === 'number' ? body.minSim : 0.4;
    const rawHeading = body.heading ? String(body.heading).trim() : null;
    const restrictRequested = !!body.restrictToHeading;

    // personfråga + namnutvinning
    const personMode = /\bvem\b/i.test(rawQ) || /\b(vem|vilka|vilken)\b.*\b(är|heter)\b/i.test(rawQ);
    function extractQueryName(q){
      const m = q.match(/vem\s+(?:är|heter)\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+)?)/i);
      if (m) return m[1].trim();
      const c = q.match(/\b[A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+)?/g);
      if (c && c.length){ c.sort((a,b)=>b.length-a.length); return c[0].trim(); }
      return '';
    }
    const explicitName = extractQueryName(rawQ);
    const nameOnly = personMode ? (explicitName || null) : null;

    const q = (rawQ || nameOnly || '').trim();
    if (!q) return res.status(422).end(JSON.stringify({ ok:false, error:'Empty query (no text or name extracted)' }));

    const map = await getMappings();
    const known = await getKnownHeadings(map.schema, map.chunksTable, map.headingCol);
    let effectiveHeading = rawHeading ? normalizeHeading(rawHeading, known) : null;
    if (personMode && !effectiveHeading && known.some(h=>/personal/.test(h))) effectiveHeading = known.find(h=>/personal/.test(h));
    const restrict    = !!effectiveHeading && (restrictRequested || personMode);
    const minScoreEff = personMode ? Math.min(minScore, 0.35) : minScore;

    // 1) Personindex (lexikal)
    let personLex = null;
    if (personMode && nameOnly){
      const peopleIndex = await buildPeopleIndex(map);
      const best = bestPersonMatch(peopleIndex, nameOnly);
      if (best){
        const e = best.entries[0];
        personLex = { from:'people_index', name:e.name, idx:e.idx??null, heading:e.heading??null, doc_id:e.doc_id??null, score:Number(best.score.toFixed(3)), text:e.text };
      }
    }

    // 2) Embedding-sök (rubrikfilter)
    const embedText = (personLex ? personLex.name : nameOnly) || q;
    const { embedding, dims } = await embedQuery(embedText);
    const vecLiteral = '[' + embedding.map((x) => Number(x).toFixed(6)).join(',') + ']';

    let sql = buildSQL(map, { filtered:true, heading:effectiveHeading, restrict });
    let params = [vecLiteral, K, minScoreEff];
    if (effectiveHeading && restrict) params.push(`%${effectiveHeading}%`);

    let rows=[];
    try { const r = await pool.query(sql, params); rows = r.rows || []; }
    catch(dbErr){
      if (/does not exist/i.test(dbErr.message)) throw new Error('Tabell/kolumn eller typ saknas – kontrollera MANUAL_* env och pgvector-installation.');
      if (/type vector/i.test(dbErr.message)) throw new Error('pgvector saknas – kör CREATE EXTENSION vector; och säkerställ vector(1536).');
      if (/is of type .* but expression is of type/i.test(dbErr.message)) throw new Error('Kolumntyp felaktig – säkerställ att embedding-kolumnen är vector(1536).');
      throw dbErr;
    }

    let usedFallback=false;
    if (!rows.length){
      usedFallback=true;
      sql = buildSQL(map, { filtered:false, heading:effectiveHeading, restrict });
      params = [vecLiteral, K];
      if (effectiveHeading && restrict) params.push(`%${effectiveHeading}%`);
      const r2 = await pool.query(sql, params); rows = r2.rows || [];
    }

    // 3) Hybrid-svar
    let snippets = rows.map((r)=>({ doc_id:r.doc_id??null, title:r.title??null, idx:r.idx??null, heading:r.heading??null, score:Number((r.score??0).toFixed(4)), text:r.chunk }));
    if (personLex){
      snippets = [{ doc_id:personLex.doc_id, title:snippets[0]?.title||null, idx:personLex.idx, heading:personLex.heading, score:personLex.score, text:personLex.text }, ...snippets];
    }

    return res.status(200).end(JSON.stringify({
      ok:true, query:rawQ, k:K, dims, heading:rawHeading||null, restricted:restrict, fallback:usedFallback,
      effective_heading:effectiveHeading||null, person_mode:!!personMode, query_used_for_embed:embedText, person_lex:personLex||null,
      snippets
    }));
  } catch (err) {
    console.error('search-manual 500', err);
    res.status(500).end(JSON.stringify({ ok:false, error: err && err.message ? err.message : String(err) }));
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
