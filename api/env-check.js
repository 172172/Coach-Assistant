// /api/env-check.js
export default async function handler(req, res) {
  try {
    const url = process.env.DATABASE_URL || "";
    const shown = url
      .replace(/:[^@]+@/, ":***@") // maska lösen
      .replace(/\?.*$/, "");       // göm query
    const hasSSL = /\bsslmode=require\b/i.test(url);
    return res.status(200).json({
      ok: true,
      database_url_preview: shown,   // t.ex. postgresql://postgres:***@db.xyz.supabase.co:5432/postgres
      has_sslmode_require: hasSSL
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
