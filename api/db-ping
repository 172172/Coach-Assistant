import { q } from "./db.js";           // din q() från /api/db.js
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const r = await q(`select
        now() as now,
        current_user as "user",
        current_database() as db,
        inet_server_addr()::text as host`);
    return res.status(200).json({ ok: true, ...r.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
