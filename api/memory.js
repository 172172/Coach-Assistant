// /api/memory.js
import { q } from "./db.js";
const ALLOWED_FIELDS = new Set(["line_name"]);

export async function getMemory(userId) {
  const r = await q(
    `select user_id, line_name, updated_at
     from user_memory
     where user_id = $1
     limit 1`,
    [userId]
  );
  return r?.rows?.[0] || {};
}

export async function upsertMemory(userId, patch = {}) {
  const clean = {};
  for (const k of Object.keys(patch || {})) {
    if (ALLOWED_FIELDS.has(k)) {
      const v = patch[k];
      if (v !== undefined && v !== null) clean[k] = String(v).trim();
    }
  }
  if (!Object.keys(clean).length) return { ok: true, updated: false };

  const cols = ["user_id", ...Object.keys(clean), "updated_at"];
  const vals = [userId, ...Object.values(clean), new Date().toISOString()];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const updates = Object.keys(clean)
    .map((k) => `${k} = EXCLUDED.${k}`)
    .concat(`updated_at = EXCLUDED.updated_at`)
    .join(", ");

  const sql = `
    insert into user_memory (${cols.join(", ")})
    values (${placeholders})
    on conflict (user_id)
    do update set ${updates}
    returning user_id, line_name, updated_at
  `;
  const r = await q(sql, vals);
  return { ok: true, updated: true, row: r?.rows?.[0] || null };
}
