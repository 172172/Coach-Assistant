// /api/db-check.js
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true, rejectUnauthorized: false },
});

export default async function handler(req, res) {
  try {
    const c = await pool.connect();
    try {
      const r = await c.query("select now() as now");
      return res.status(200).json({ ok: true, now: r.rows[0].now });
    } finally {
      c.release();
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
