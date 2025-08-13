import { q } from "./db.js";

export default async function handler(req, res) {
  try {
    // Försök med created_at om kolumnen finns
    try {
      const r = await q(`
        select id, title, version, is_active, created_at
        from manual_docs
        order by created_at desc nulls last
        limit 10
      `);
      return res.status(200).json({ ok: true, docs: r.rows, used: "created_at" });
    } catch (e) {
      // Fallback: sortera på id om created_at saknas
      const r = await q(`
        select id, title, version, is_active
        from manual_docs
        order by id desc
        limit 10
      `);
      return res.status(200).json({ ok: true, docs: r.rows, used: "id" });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
