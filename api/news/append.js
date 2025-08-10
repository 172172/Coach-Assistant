// /api/news/append.js  — samma stil som incidents/report.js (pg via db.js)
import { q } from "../db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error: "Only POST allowed" });

  // (valfritt) admin-lås, om du vill matcha news.html som skickar X-Admin-Token
  const token = req.headers["x-admin-token"];
  if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  }

  try {
    const {
      title = "",
      body: text = "",
      area = null,            // t.ex. Tapp, OCME, Jones, …
      shift = null,           // "A" | "B" | "C" | "D" | null
      tags = [],              // array av text
      news_at = null,         // ISO string eller tomt -> now()
      user_id: userIdRaw = null,
      source = "ui"
    } = (req.body || {});

    const user_id = (typeof userIdRaw === "string" && userIdRaw) || req.headers["x-user-id"] || "anon";

    if (!text || text.trim().length < 3) {
      return res.status(400).json({ ok:false, error:"body (text) is required" });
    }

    // Sätt tid
    const newsAtIso = news_at ? new Date(news_at).toISOString() : new Date().toISOString();

    // INSERT — Postgres hanterar JS-array -> text[] automatiskt via pg
    const r = await q(
      `insert into line_news (title, body, area, shift, tags, news_at, user_id, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id, created_at, news_at`,
      [
        title || null,
        text.trim(),
        area,
        shift,
        Array.isArray(tags) ? tags : [],
        newsAtIso,
        user_id,
        source
      ]
    );

    const row = r?.rows?.[0] || null;
    return res.status(200).json({ ok:true, news: row });
  } catch (e) {
    console.error("news/append error:", e);
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
