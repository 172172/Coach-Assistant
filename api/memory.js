// /api/memory.js
// Enkel profil-minne i tabellen user_memory + OpenAI integration

import { q } from "./db.js";

// /api/memory.js
// Enkel profil-minne i tabellen user_memory + OpenAI integration

import { q } from "./db.js";

// OpenAI API integration
export async function getOpenAIResponse(prompt, temperature = 0.7, maxTokens = 800) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // eller "gpt-3.5-turbo" för billigare alternativ
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" } // Tvingar JSON-svar
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error("No content in OpenAI response");
    }

    return content;
  } catch (error) {
    console.error('OpenAI API error:', error);
    
    // Fallback-svar om OpenAI misslyckas
    const fallbackResponse = {
      spoken: "Ursäkta, jag hade lite tekniska problem just nu. Kan du försöka igen?",
      cards: {
        summary: "Tekniskt fel - OpenAI otillgänglig",
        steps: [],
        explanation: "",
        pitfalls: [],
        matched_headings: []
      },
      follow_up: "Försök gärna igen om ett par sekunder.",
      meta: {
        confidence: 0.1,
        error: true
      }
    };
    
    return JSON.stringify(fallbackResponse);
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
