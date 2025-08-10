// /api/incidents/report.js
import { q } from "../db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  try {
    const {
      area = null,
      title = "",
      problem = "",
      resolution = "",
      severity = "medium",
      tags = [],
      reporter_name = null,
      userId: userIdRaw = null
    } = (req.body || {});

    const userId = (typeof userIdRaw === "string" && userIdRaw) || req.headers["x-user-id"] || "anon";

    if (!title || !problem) {
      return res.status(400).json({ ok: false, error: "title och problem krävs" });
    }
    const sev = ["low","medium","high","critical"].includes(String(severity)) ? String(severity) : "medium";

    const r = await q(
      `insert into incidents (user_id, reporter_name, area, title, problem, resolution, severity, status, tags, source)
       values ($1,$2,$3,$4,$5,$6,$7,'open',$8,'operator')
       returning id, reported_at`,
      [ userId, reporter_name, area, title, problem, resolution, sev, Array.isArray(tags) ? tags : [] ]
    );

    return res.status(200).json({ ok: true, id: r?.rows?.[0]?.id, reported_at: r?.rows?.[0]?.reported_at });
  } catch (e) {
    console.error("incidents/report error:", e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
