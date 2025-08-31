// /api/search-manual.js – v5
// HYBRID (vector + trigram) + RRF + rubrik-normalisering + GET-stöd + timeouts

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
const quoteIdent = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// Embeddings med timeout
async function embedQuery(q) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY saknas (env)');
  const model = process.env.EMBED_MODEL || 'text-embedding-3-small'; // 1536-dim

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: q }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`OpenAI embeddings misslyckades: ${r.status} ${r.statusText} – ${t.slice(0,200)}`);
    }
    const j = await r.json();
    const emb = j.data?.[0]?.embedding;
    if (!emb) throw new Error('Embedding saknas i OpenAI-svar');
    return { embedding: emb, model, dims: emb.length };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') throw new Error('OpenAI embedding timeout - tog för lång tid');
    throw e;
  }
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

  const textCol   = pick('MANUAL_TEXT_COL',   ['chunk','content','text','body','raw','paragraph']);
  const embCol    = pick('MANUAL_EMB_COL',    ['embedding','vector','emb','embedding_1536','embed']);
  const idxCol    = pick('MANUAL_IDX_COL',    ['idx','chunk_index','position','ord','i']);
  const headingCol= pick('MANUAL_HEADING_COL',['heading','section','h1','h2']);
  const docIdCol  = pick('MANUAL_DOCID_COL',  ['doc_id','document_id','docid','source_id','doc']);

  if (!textCol) throw new Error('Kunde inte hitta textkolumn (chunk/content/text/body/raw/paragraph). Sätt MANUAL_TEXT_COL.');
  if (!embCol)  throw new Error('Kunde inte hitta embedding-kolumn (embedding/vector/emb/embedding_1536/embed). Sätt MANUAL_EMB_COL.');

  let join = { exists:false };
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
      idCol: pickDocs('MANUAL_DOCS_ID_COL',    ['id','doc_id','document_id','docid']),
      titleCol: pickDocs('MANUAL_DOCS_TITLE_COL',['title','name','doc_title']),
    };
  }

  return { schema, chunksTable, textCol, embCol, idxCol, headingCol, docIdCol, join };
}

// ---- Rubriker + personläge ----
let __knownHeadings = null;
async function getKnownHeadings(schema, table, headingCol) {
  if (__knownHeadings) return __knownHeadings;
  if (!headingCol) { __knownHeadings = []; return __knownHeadings; }
  const q = `
    SELECT DISTINCT ${quoteIdent(headingCol)} AS h
    FROM ${quoteIdent(schema)}.${quoteIdent(table)}
    WHERE ${quoteIdent(headingCol)} IS NOT NULL AND ${quoteIdent(headingCol)} <> ''
    LIMIT 2000
  `;
  const { rows } = await pool.query(q);
  __knownHeadings = rows
    .map(r => String(r.h || ''))
    .map(s => s.toLowerCase().replace(/["'`]/g,'').replace(/^\s*:\s*/,'').trim()) // sanera
    .filter(Boolean);
  return __knownHeadings;
}

function normalizeHeading(raw, known) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/["'`]/g,'').replace(/^\s*:\s*/,'').trim();
  if (!s) return null;

  for (const h of known) if (s.includes(h)) return h;

  const toks = s.split(/[^a-zåäö0-9]+/i).filter(w => w.length > 2);
  let best = null, bestScore = 0;
  for (const h of known) {
    const hs = h.split(/[^a-zåäö0-9]+/i);
    const overlap = hs.reduce((acc,w)=> acc + (toks.includes(w) ? 1 : 0), 0);
    if (overlap > bestScore) { best = h; bestScore = overlap; }
  }
  return bestScore > 0 ? best : null;
}

function extractPersonName(q) {
  const m = q.match(/vem\s+(?:är|heter)\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+)?)/i);
  if (m) return m[1].trim();
  const candidates = q.match(/\b[A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+)?/g);
  if (candidates?.length) {
    candidates.sort((a,b)=>b.length - a.length);
    return candidates[0].trim();
  }
  return null;
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
  // Global timeout för hela anropet
  const HANDLER_TIMEOUT = 25000;
  const timeoutId = setTimeout(() => {
    if (!res.writableEnded) {
      res.status(408).json({ ok:false, error:'Timeout - sökningen tog för lång tid', snippets:[] });
    }
  }, HANDLER_TIMEOUT);

  res.setHeader('Content-Type', 'application/json');

  // Tillåt GET (för delning/test) och POST (produktion)
  let body = {};
  try {
    if (req.method === 'GET') {
      body = {
        query: (req.query?.q ?? req.query?.query ?? '').toString(),
        k: parseInt(req.query?.k ?? '5', 10) || 5,
        minSim: req.query?.minSim ? parseFloat(req.query.minSim) : undefined,
        heading: (req.query?.heading ?? req.query?.h ?? '').toString() || null,
        restrictToHeading: ['1','true','on','yes'].includes(String(req.query?.restrict ?? req.query?.r ?? '').toLowerCase())
      };
    } else if (req.method === 'POST') {
      body = readJsonBody(req) || {};
    } else {
      clearTimeout(timeoutId);
      return res.status(405).end(JSON.stringify({ ok:false, error:'Method not allowed' }));
    }
  } catch (e) {
    clearTimeout(timeoutId);
    return res.status(400).end(JSON.stringify({ ok:false, error:'Bad request', details:String(e) }));
  }

  try {
    const rawQ = (body.query || '').trim();
    const K = Math.min(Math.max(parseInt(body.k || body.topK || 5, 10) || 5, 1), 20);
    const minScore = typeof body.minSim === 'number' ? body.minSim : 0.3; // snällare default
    const rawHeading = body.heading ? String(body.heading).trim() : null;
    const restrictRequested = !!body.restrictToHeading;

    const personMode = /\bvem\b/i.test(rawQ) || /\b(vem|vilka|vilken)\b.*\b(är|heter)\b/i.test(rawQ);
    const nameOnly = personMode ? extractPersonName(rawQ) : null;

    const q = (rawQ || nameOnly || '').trim();
    if (!q) {
      clearTimeout(timeoutId);
      if (req.method === 'GET') {
        return res.status(200).json({
          ok:false, error:'missing_query',
          usage:'GET /api/search-manual?q=din+fråga&k=5&minSim=0.3&heading=Rubrik&restrict=1',
          snippets:[]
        });
      }
      return res.status(422).json({ ok:false, error:'Empty query (no text or name extracted)', snippets:[] });
    }

    const map = await getMappings();
    const known = await getKnownHeadings(map.schema, map.chunksTable, map.headingCol);

    let effectiveHeading = rawHeading ? normalizeHeading(rawHeading, known) : null;
    if (personMode && !effectiveHeading && known.includes('personal')) {
      effectiveHeading = 'personal';
    }
    const restrict = !!effectiveHeading && (restrictRequested || personMode);
    const minScoreEff = personMode ? Math.min(minScore, 0.35) : minScore;

    // 1) Vector
    const embedText = nameOnly || q;
    const { embedding, dims } = await embedQuery(embedText);
    const vecLiteral = '[' + embedding.map((x) => Number(x).toFixed(6)).join(',') + ']';

    let sql = buildSQL(map, { filtered: true, heading: effectiveHeading, restrict });
    let params = [vecLiteral, K, minScoreEff];
    if (effectiveHeading && restrict) params.push(`%${effectiveHeading}%`);

    let rows = [];
    try {
      const r = await pool.query(sql, params);
      rows = r.rows || [];
    } catch (dbErr) {
      if (/operator does not exist|does not exist/i.test(dbErr.message))
        throw new Error('Tabell/kolumn/typ saknas – kontrollera MANUAL_* env och pgvector-installation.');
      if (/type vector/i.test(dbErr.message))
        throw new Error('pgvector saknas – kör CREATE EXTENSION vector; och säkerställ vector(1536).');
      if (/is of type .* but expression is of type/i.test(dbErr.message))
        throw new Error('Kolumntyp felaktig – säkerställ att embedding-kolumnen är vector(1536).');
      throw dbErr;
    }

    let usedFallback = false;
    if (!rows.length) {
      usedFallback = true;
      sql = buildSQL(map, { filtered: false, heading: effectiveHeading, restrict });
      params = [vecLiteral, K];
      if (effectiveHeading && restrict) params.push(`%${effectiveHeading}%`);
      const r2 = await pool.query(sql, params);
      rows = r2.rows || [];
    }

    // 2) Lexikal (pg_trgm)
    const qLower = q.toLowerCase();
    const lexK = Math.max(K, 8);
    const lexParams = [qLower, lexK];
    let lexWhere = `(lower(c.${quoteIdent(map.textCol)}) % $1`;
    if (map.headingCol) lexWhere += ` OR lower(c.${quoteIdent(map.headingCol)}) % $1`;
    lexWhere += `)`;
    let lexHeadingParamIndex = 3;
    if (effectiveHeading && restrict) {
      lexWhere += ` AND (COALESCE(${map.headingCol ? `c.${quoteIdent(map.headingCol)}` : `' '`}, '') ILIKE $${lexHeadingParamIndex})`;
      lexParams.push(`%${effectiveHeading}%`);
      lexHeadingParamIndex++;
    }

    const lexSQL = `
      SELECT
        ${map.docIdCol ? `c.${quoteIdent(map.docIdCol)} AS doc_id,` : `NULL AS doc_id,`}
        ${map.idxCol ? `c.${quoteIdent(map.idxCol)} AS idx,` : `NULL AS idx,`}
        ${map.headingCol ? `c.${quoteIdent(map.headingCol)} AS heading,` : `NULL AS heading,`}
        ${map.join.exists && map.join.titleCol ? `d.${quoteIdent(map.join.titleCol)} AS title,` : `NULL AS title,`}
        c.${quoteIdent(map.textCol)} AS chunk,
        GREATEST(
          similarity(lower(c.${quoteIdent(map.textCol)}), $1),
          ${map.headingCol ? `similarity(lower(c.${quoteIdent(map.headingCol)}), $1)` : '0'}
        ) AS lex_score
      FROM ${quoteIdent(map.schema)}.${quoteIdent(map.chunksTable)} c
      ${map.join.exists && map.docIdCol ? `LEFT JOIN ${quoteIdent(map.join.schema)}.${quoteIdent(map.join.table)} d ON d.${quoteIdent(map.join.idCol)} = c.${quoteIdent(map.docIdCol)}` : ''}
      WHERE ${lexWhere}
      ORDER BY lex_score DESC
      LIMIT $2
    `;
    let lexRows = [];
    try {
      const rLex = await pool.query(lexSQL, lexParams);
      lexRows = rLex.rows || [];
    } catch {
      lexRows = []; // pg_trgm saknas – kör utan lex
    }

    // 3) RRF-fusion
    const keyOf = (r) => `${r.doc_id ?? ''}|${r.idx ?? ''}|${r.heading ?? ''}|${String(r.chunk||'').slice(0,24)}`;
    const rrf = (list) => {
      const m = new Map();
      list.forEach((it, i) => m.set(keyOf(it), 1 / (60 + i))); // k=60
      return m;
    };
    const r1 = rrf(rows);
    const r2 = rrf(lexRows);

    const mergedScore = new Map();
    for (const [k,v] of r1) mergedScore.set(k, (mergedScore.get(k)||0) + v);
    for (const [k,v] of r2) mergedScore.set(k, (mergedScore.get(k)||0) + v);

    const byKey = new Map();
    rows.forEach(r => byKey.set(keyOf(r), {
      doc_id: r.doc_id ?? null,
      title: r.title ?? null,
      idx: r.idx ?? null,
      heading: r.heading ?? null,
      score: Number((r.score ?? 0).toFixed(4)),
      text: r.chunk
    }));
    lexRows.forEach(r => {
      const k = keyOf(r);
      if (!byKey.has(k)) {
        byKey.set(k, {
          doc_id: r.doc_id ?? null,
          title: r.title ?? null,
          idx: r.idx ?? null,
          heading: r.heading ?? null,
          score: Number((r.lex_score ?? 0).toFixed(4)),
          text: r.chunk
        });
      }
    });

    const fused = [...mergedScore.entries()]
      .sort((a,b)=> b[1]-a[1])
      .map(([k]) => byKey.get(k))
      .slice(0, K);

    clearTimeout(timeoutId);
    return res.status(200).json({
      ok: true,
      query: rawQ,
      k: K,
      dims,
      heading: rawHeading || null,
      restricted: restrict,
      fallback: usedFallback,
      effective_heading: effectiveHeading || null,
      person_mode: !!personMode,
      query_used_for_embed: embedText,
      fusion: { vec_count: rows.length, lex_count: lexRows.length },
      snippets: fused || []
    });
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('search-manual error:', err);
    return res.status(500).json({ ok:false, error: err?.message || String(err), snippets:[] });
  }
}

/*
SQL att köra (en gång) för prestanda:

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ALTER TABLE public.manual_chunks ALTER COLUMN embedding TYPE vector(1536);
CREATE INDEX IF NOT EXISTS manual_chunks_emb_cos_idx
  ON public.manual_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS manual_chunks_chunk_trgm_idx
  ON public.manual_chunks USING GIN ((lower(chunk)) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS manual_chunks_heading_trgm_idx
  ON public.manual_chunks USING GIN ((lower(heading)) gin_trgm_ops);

ANALYZE public.manual_chunks;
*/
