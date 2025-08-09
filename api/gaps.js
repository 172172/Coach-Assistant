// /api/gaps.js
// Enkel admin-API för att lista och uppdatera kunskapsluckor.

import { q } from "./db.js";

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  try {
    const method = req.method;
    // (Enkel skyddsmekanism, lägg ev. ADMIN_TOKEN i env)
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (method === "GET") {
      const status = (req.query.status || "open").toString();
      const r = await q(
        `select id, status, asked_at, user_id, question, coverage, matched_headings,
                gap_reason, draft_title, draft_heading, draft_md, draft_outline, priority
         from kb_gaps
         where status = $1
         order by asked_at desc
         limit 200`,
        [status]
      );
      return res.status(200).json({ gaps: r.rows || [] });
    }

    if (method === "POST") {
      const { id, action } = req.body || {};
      if (!id || !action) return res.status(400).json({ error: "id and action required" });

      const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : null;
      if (!status) return res.status(400).json({ error: "invalid action" });

      await q(`update kb_gaps set status = $1 where id = $2`, [status, id]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("gaps.js error:", e);
    return res.status(500).json({ error: "Serverfel i gaps.js", details: e?.message || String(e) });
  }
}
