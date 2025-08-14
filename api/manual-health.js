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

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const schema = process.env.MANUAL_SCHEMA || 'public';
    const table  = process.env.MANUAL_TABLE  || 'manual_chunks';

    await pool.query('SELECT 1');

    const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname='vector'");
    const tab = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2`,
      [schema, table]
    );

    let row_count = 0;
    if (tab.rowCount > 0) {
      const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${schema}.${table}`);
      row_count = r.rows?.[0]?.c || 0;
    }

    res.status(200).end(JSON.stringify({
      ok: true,
      db_ok: true,
      vector_ext: ext.rowCount > 0,
      table_ok: tab.rowCount > 0,
      row_count
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  }
}
