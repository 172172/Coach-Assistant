// /api/log-test.js
// Snabb sanity: skriver en rad i `messages` och returnerar id eller fel.

import { q } from "./db.js";

export default async function handler(req, res) {
  try {
    const userId = req.headers["x-user-id"] || "log-test";
    const r = await q(
      `insert into messages(user_id, asked_at, question, reply_json, smalltalk, is_operational, coverage, matched_headings, lane, intent)
       values ($1, now(), $2, $3::jsonb, false, false, 0, $4::text[], 'diagnostic', 'ping')
       returning id, asked_at`,
      [userId, "ping from /api/log-test", JSON.stringify({ ok: true }), []]
    );
    return res.status(200).json({ ok: true, id: r.rows[0].id, asked_at: r.rows[0].asked_at });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || String(e)
    });
  }
}
