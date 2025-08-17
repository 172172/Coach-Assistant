// /api/people-lookup.js — robust personsök (namn-extraktion + normalisering + fallbacks)
import { Pool } from 'pg';

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

function readJsonBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return req.body;
  } catch { return {}; }
}

// Plocka ut namn ur fraser som "Vem är Oskar Vigstrand?"
function extractName(qRaw) {
  const q = String(qRaw || '').trim().replace(/[?!.\s]+$/,'');
  const stripped = q
    .replace(/^(vem\s+(är|heter)\s+|who\s+is\s+|vad\s+heter\s+)/i, '')
    .trim();
  const m = stripped.match(/[A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö\-]+)?/);
  if (m) return m[0].trim();
  // fallback: ta de första 1–2 token som “ser ut” som namn
  const toks = stripped.split(/\s+/).filter(Boolean);
  return toks.slice(0, 2).join(' ').trim() || stripped;
}

// Normalisera vanliga felhörningar/stavningar
function normalizePersonSpelling(name) {
  let s = name;
  s = s.replace(/\bWigstrand\b/gi, 'Vigstrand'); // ASR felhörning
  // Vi har alias för både Oscar/Oskar, men att mappa till "Oskar" hjälper pg_trgm-filtret ibland.
  s = s.replace(/\bOscar\b/gi, 'Oskar');
  return s.trim();
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST')
    return res.status(405).end(JSON.stringify({ ok:false, error:'Method not allowed' }));

  try {
    const body = readJsonBody(req);
    const qIn = (body.q || body.query || '').trim();
    if (!qIn) return res.status(422).end(JSON.stringify({ ok:false, error:'Empty query' }));

    const topk = Number.isFinite(body.topk) ? Math.max(1, Math.min(10, body.topk)) : 5;
    const minScore = typeof body.minScore === 'number' ? body.minScore : 0.68;

    // 1) Extrahera & normalisera namn
    const extracted = extractName(qIn);
    const norm = normalizePersonSpelling(extracted);

    async function runLookup(q) {
      // Försök RPC först
      try {
        const rpc = await pool.query(
          `select * from public.people_lookup($1::text, $2::int, $3::float)`,
          [q, topk, minScore]
        );
        return rpc.rows || [];
      } catch {
        // Fallback: trigram på full_name/aliases
        const { rows } = await pool.query(
          `
          with q as (select lower(unaccent($1::text)) as ql)
          select id, full_name, role, unit, source_doc, section, idx,
                 greatest(
                   similarity(lower(unaccent(full_name)), (select ql from q)),
                   similarity(lower(unaccent(array_to_string(aliases,' '))), (select ql from q))
                 ) as score,
                 'fallback_trgm' as match
          from public.people
          where lower(unaccent(full_name)) % (select ql from q)
             or lower(unaccent(array_to_string(aliases,' '))) % (select ql from q)
          order by score desc, full_name asc
          limit $2
          `,
          [q, topk]
        );
        return (rows || []).filter(r => Number(r.score || 0) >= minScore);
      }
    }

    // Query-strategi: norm → förnamn → original (ifall allt annat faller)
    const tries = [];
    tries.push(norm);
    const first = norm.split(/\s+/)[0];
    if (first && !tries.includes(first)) tries.push(first);
    if (!tries.includes(qIn)) tries.push(qIn);

    let rows = [];
    for (const t of tries) {
      rows = await runLookup(t);
      if (rows.length) break;
    }

    return res.status(200).end(JSON.stringify({
      ok: true,
      q_in: qIn,
      q_extracted: extracted,
      q_used: rows.length ? tries[tries.findIndex(x => rows.length)] : tries[0],
      topk,
      minScore,
      rows: rows.map(r => ({
        id: r.id,
        full_name: r.full_name,
        role: r.role,
        unit: r.unit,
        source_doc: r.source_doc,
        section: r.section,
        idx: r.idx,
        score: Number((r.score ?? 0).toFixed(3)),
        match: r.match || 'rpc'
      }))
    }));
  } catch (err) {
    console.error('people-lookup 500', err);
    res.status(500).end(JSON.stringify({ ok:false, error: err?.message || String(err) }));
  }
}
