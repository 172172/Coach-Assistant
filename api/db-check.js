// /api/db-check.js
import { Pool } from "pg";
const pool = new (await import("pg")).Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
export default async function handler(req, res) {
  try {
    const client = await pool.connect();
    try {
      const r = await client.query("select now() as now");
      return res.status(200).json({ ok: true, now: r.rows[0].now });
    } finally {
      client.release();
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
