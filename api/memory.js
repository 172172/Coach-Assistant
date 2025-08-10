// /api/memory.js
// Enkel profil-minne i tabellen user_memory + OpenAI integration

import { q } from "./db.js";

// OpenAI API integration
export async function getOpenAIResponse(prompt, temperature = 0.7, maxTokens = 800) {
  try {
    // Detta är en placeholder - du behöver implementera din OpenAI-integration
    // Baserat på din setup, returnera ett JSON-svar eller text
    
    // För nu, simulera ett svar
    const response = {
      spoken: "Det här är en placeholder för OpenAI-integration. Implementera din AI-logik här.",
      cards: {
        summary: "Simulerat svar",
        steps: [],
        explanation: "",
        pitfalls: [],
        matched_headings: []
      },
      follow_up: "Vad mer vill du veta?",
      meta: {
        confidence: 0.8
      }
    };
    
    return JSON.stringify(response);
  } catch (error) {
    console.error('OpenAI API error:', error);
    throw error;
  }
}

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
