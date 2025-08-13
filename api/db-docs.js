import { q } from "./db.js";

export default async function handler(req, res) {
  try {
    const r = await q(`
      select id, title, version, is_active, created_at
      from manual_docs
      order by created_at desc
      limit 10
    `);
    res.status(200).json({ ok: true, docs: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
