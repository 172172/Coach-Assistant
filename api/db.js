// /api/memory.js
// Enkel profil-minne i tabellen user_memory + OpenAI integration

import { q } from "./db.js";

// /api/memory.js
// Enkel profil-minne i tabellen user_memory + OpenAI integration

import { q } from "./db.js";

// OpenAI API integration
export async function getOpenAIResponse(prompt, temperature = 0.7, maxTokens = 800) {
  try {
    console.log('Calling OpenAI API...');
    
    // Kontrollera att API-nyckeln finns
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable not set');
    }
    
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo", // Använd mer kompatibel modell
        messages: [
          {
            role: "system",
            content: "Du är Alex, en hjälpsam AI-assistent. Du MÅSTE alltid svara i giltigt JSON-format enligt de instruktioner du får."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: temperature,
        max_tokens: maxTokens
        // Ta bort response_format för nu - kan orsaka problem
      })
    });

    console.log('OpenAI response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error response:', errorText);
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    console.log('OpenAI response received, choices:', data.choices?.length);
    
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error("No content in OpenAI response");
    }

    console.log('Raw OpenAI content length:', content.length);
    
    // Försök rensa innehållet om det inte är giltigt JSON
    let cleanContent = content.trim();
    
    // Ta bort markdown code blocks om de finns
    if (cleanContent.startsWith('```json')) {
      cleanContent = cleanContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    // Testa att det är giltigt JSON innan vi returnerar det
    try {
      JSON.parse(cleanContent);
      return cleanContent;
    } catch (jsonError) {
      console.error('OpenAI returned invalid JSON:', cleanContent);
      console.error('JSON parse error:', jsonError.message);
      throw new Error('OpenAI returned invalid JSON: ' + jsonError.message);
    }

  } catch (error) {
    console.error('OpenAI API error:', error.message);
    
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
        error: true,
        error_message: error.message
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
