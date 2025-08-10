// /api/news/upsert.js
import { q } from "../db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  try {
    // kräver admin-token
    const token = req.headers["x-admin-token"] || req.query?.token;
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const {
      section,                      // 'shift' | 'maintenance' | 'management' | 'production'
      title = "",
      body = "",
      tags = [],
      effective_date = null,        // valfritt "YYYY-MM-DD"
      created_by = null
    } = (req.body || {});

    if (!section || !title || !body) {
      return res.status(400).json({ ok: false, error: "section, title, body krävs" });
    }
    const allowed = ["shift","maintenance","management","production"];
    if (!allowed.includes(String(section))) {
      return res.status(400).json({ ok: false, error: "ogiltig section" });
    }

    const r = await q(
      `insert into line_news (section, title, body, tags, effective_date, created_by)
       values ($1,$2,$3,$4, coalesce($5, (now() at time zone 'Europe/Stockholm')::date), $6)
       returning id, created_at, effective_date`,
      [ section, title, body, Array.isArray(tags) ? tags : [], effective_date, created_by ]
    );

    return res.status(200).json({ ok: true, id: r?.rows?.[0]?.id, created_at: r?.rows?.[0]?.created_at, effective_date: r?.rows?.[0]?.effective_date });
  } catch (e) {
    console.error("news/upsert error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
