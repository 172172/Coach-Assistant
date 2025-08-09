// /api/db-check.js
import { Pool } from "pg";
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 6543,
  database: process.env.PGDATABASE || "postgres",
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { require: true, rejectUnauthorized: false },
});
export default async function handler(req, res) {
  try {
    const c = await pool.connect();
    try {
      const r = await c.query("select now() as now");
      res.status(200).json({ ok: true, now: r.rows[0].now });
    } finally {
      c.release();
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
