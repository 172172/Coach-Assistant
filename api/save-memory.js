// /api/save-memory.js
import { q } from "./db.js";
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });
  try {
    const { userId = "kevin", key, value } = req.body || {};
    if (!key || !value) return res.status(400).json({ error: "Missing key/value" });

    const upd = await q(
      `update user_memory set value = $3, updated_at = now()
        where user_id = $1 and key = $2`,
      [userId, key, value]
    );
    if (upd.rowCount === 0) {
      await q(
        `insert into user_memory (user_id, key, value)
         values ($1, $2, $3)`,
        [userId, key, value]
      );
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
