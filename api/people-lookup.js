// /api/people-lookup.js — deterministisk personsök mot Supabase (People-KB)
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

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST')
    return res.status(405).end(JSON.stringify({ ok:false, error:'Method not allowed' }));

  try {
    const body = readJsonBody(req);
    const qRaw = (body.q || body.query || '').trim();
    const topk = Number.isFinite(body.topk) ? Math.max(1, Math.min(10, body.topk)) : 3;
    const minScore = typeof body.minScore === 'number' ? body.minScore : 0.72;

    if (!qRaw) return res.status(422).end(JSON.stringify({ ok:false, error:'Empty query' }));

    // Försök RPC först (om du skapade public.people_lookup)
    let rows = [];
    try {
      const rpc = await pool.query(
        `select * from public.people_lookup($1::text, $2::int, $3::float)`,
        [qRaw, topk, minScore]
      );
      rows = rpc.rows || [];
    } catch (e) {
      // Fallback: enkel, säker SELECT om RPC saknas – kräver kolumnerna från vår migration
      const fallback = await pool.query(
        `
        with q as (select lower(unaccent($1::text)) as ql)
        select id, full_name, role, unit, source_doc, section, idx,
               -- enkel score: trigram-similaritet på full_name/aliases
               greatest(
                 similarity(lower(unaccent(full_name)), (select ql from q)),
                 similarity(lower(unaccent(array_to_string(aliases,' '))), (select ql from q))
               ) as score,
               'fallback_trgm' as match
        from public.people
        where
          lower(unaccent(full_name)) % (select ql from q)
          or lower(unaccent(array_to_string(aliases,' '))) % (select ql from q)
        order by score desc, full_name asc
        limit $2
        `,
        [qRaw, topk]
      );
      rows = fallback.rows || [];
      // Filtrera manuellt på minScore i fallback-läget
      rows = rows.filter(r => Number(r.score || 0) >= minScore);
    }

    return res.status(200).end(JSON.stringify({
      ok: true,
      q: qRaw,
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
