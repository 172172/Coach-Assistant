// /api/memory.js
// Enkla helpers för user memory (profil) i Postgres (Supabase).
// Använder q(sql, params) från db.js

import { q } from "./db.js";

// Tillåtna fält i memory (whitelist)
const ALLOWED_FIELDS = new Set(["line_name", "shift", "role"]);

/**
 * Hämtar memory-objekt för given userId.
 * Returnerar {} om inget finns.
 */
export async function getMemory(userId) {
  const r = await q(
    `select user_id, line_name, shift, role, updated_at
     from user_memory
     where user_id = $1
     limit 1`,
    [userId]
  );
  return r?.rows?.[0] || {};
}

/**
 * Upsert av memory-fält för userId.
 * patch = { line_name?, shift?, role? }
 */
export async function upsertMemory(userId, patch = {}) {
  // filtrera mot whitelist
  const clean = {};
  for (const k of Object.keys(patch || {})) {
    if (ALLOWED_FIELDS.has(k)) {
      const v = patch[k];
      if (v !== undefined && v !== null) clean[k] = String(v).trim();
    }
  }
  if (!Object.keys(clean).length) return { ok: true, updated: false };

  // bygg columns/values för upsert
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
    returning user_id, line_name, shift, role, updated_at
  `;
  const r = await q(sql, vals);
  return { ok: true, updated: true, row: r?.rows?.[0] || null };
}
