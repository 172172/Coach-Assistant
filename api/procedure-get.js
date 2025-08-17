// /api/procedure-get.js
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

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    return res.status(405).end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const slug = (body.slug || '').trim();
    if (!slug) return res.status(422).end(JSON.stringify({ ok: false, error: 'missing slug' }));
    const { rows } = await pool.query(
      'select slug, title, recipe, source_doc, section from public.procedures where slug=$1 limit 1',
      [slug]
    );
    if (!rows.length) return res.status(404).end(JSON.stringify({ ok: false, error: 'not found' }));
    return res.status(200).end(JSON.stringify({ ok: true, procedure: rows[0] }));
  } catch (e) {
    console.error('procedure-get 500', e);
    return res.status(500).end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  }
}
