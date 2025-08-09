// /api/memory.js
// Enkel profil-minne i tabellen user_memory

import { q } from "./db.js";

export async function getMemory(userId) {
  try {
    const r = await q(`select user_id, line_name, updated_at from user_memory where user_id = $1`, [userId]);
    return r.rows?.[0] || null;
  } catch (e) {
    console.warn("getMemory failed:", e?.message || e);
    return null;
  }
}

export async function upsertMemory(userId, patch = {}) {
  try {
    const { line_name = null } = patch;
    const r = await q(
      `insert into user_memory(user_id, line_name, updated_at)
       values ($1, $2, now())
       on conflict (user_id)
       do update set
         line_name = coalesce(excluded.line_name, user_memory.line_name),
         updated_at = now()
       returning user_id, line_name, updated_at`,
      [userId, line_name]
    );
    return { ok: true, row: r.rows?.[0] || null };
  } catch (e) {
    console.warn("upsertMemory failed:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}
