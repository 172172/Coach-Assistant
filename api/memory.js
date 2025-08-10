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

// --- Utökad state/memory (rolling summary + preferenser) ---
export async function getState(userId) {
  try {
    const r = await q(
      `select user_id, line_name, pace, detail_level, humor_level, rolling_summary
       from user_memory_state where user_id = $1`,
      [userId]
    );
    return r.rows?.[0] || null;
  } catch (e) {
    console.warn("getState failed:", e.message);
    return null;
  }
}

export async function upsertState(userId, patch = {}) {
  const { pace=null, detail_level=null, humor_level=null } = patch;
  try {
    const r = await q(
      `insert into user_memory_state (user_id, pace, detail_level, humor_level, updated_at)
       values ($1,$2,$3,$4, now())
       on conflict (user_id) do update
       set pace = coalesce(excluded.pace, user_memory_state.pace),
           detail_level = coalesce(excluded.detail_level, user_memory_state.detail_level),
           humor_level = coalesce(excluded.humor_level, user_memory_state.humor_level),
           updated_at = now()
       returning user_id, pace, detail_level, humor_level`,
      [userId, pace, detail_level, humor_level]
    );
    return r.rows?.[0] || null;
  } catch (e) {
    console.warn("upsertState failed:", e.message);
    return null;
  }
}

export async function updateRollingSummary(userId, delta) {
  try {
    const r = await q(
      `insert into user_memory_state(user_id, rolling_summary, updated_at)
       values ($1, left($2,4000), now())
       on conflict (user_id) do update
       set rolling_summary = left(
             coalesce(user_memory_state.rolling_summary,'') || E'\n' || $2, 4000),
           updated_at = now()
       returning rolling_summary`,
      [userId, delta.trim()]
    );
    return r.rows?.[0]?.rolling_summary || "";
  } catch (e) {
    console.warn("updateRollingSummary failed:", e.message);
    return "";
  }
}

export async function logEvent(userId, kind, payload = {}) {
  try {
    await q(
      `insert into user_memory_events(user_id, kind, payload) values ($1,$2,$3::jsonb)`,
      [userId, kind, JSON.stringify(payload)]
    );
  } catch (e) {
    console.warn("logEvent failed:", e.message);
  }
}
