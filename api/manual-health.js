// /api/manual-health.js
const { Pool } = require('pg');

const pool =
  global.pgPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.PGSSL === 'false'
        ? false
        : { rejectUnauthorized: false },
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE
  });
if (!global.pgPool) global.pgPool = pool;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const schema = process.env.MANUAL_SCHEMA || 'public';
    const table = process.env.MANUAL_TABLE || 'manual_chunks';

    let db_ok = true, vector_ext = false, table_ok = false, row_count = 0;

    // 1) Testa anslutning
    await pool.query('SELECT 1');

    // 2) Finns pgvector?
    try {
      const r = await pool.query("SELECT extname FROM pg_extension WHERE extname='vector'");
      vector_ext = r.rowCount > 0;
    } catch {}

    // 3) Finns tabellen?
    try {
      const r = await pool.query(`
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema=$1 AND table_name=$2
      `, [schema, table]);
      table_ok = r.rowCount > 0;
    } catch {}

    // 4) Hur många rader?
    if (table_ok) {
      const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${schema}.${table}`);
      row_count = r.rows?.[0]?.c || 0;
    }

    res.status(200).end(JSON.stringify({
      ok: true, db_ok, vector_ext, table_ok, row_count
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  }
};
