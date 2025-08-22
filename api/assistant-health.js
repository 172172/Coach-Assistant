 // /api/assistant-health.js  (ESM, funkar med "type":"module")
import OpenAI from "openai";

const API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY; // fallback om du råkat döpa annorlunda
const client = new OpenAI({ apiKey: API_KEY });

export default async function handler(req, res) {
  try {
    // 1) Env-kontroll
    if (!API_KEY) {
      return res.status(500).json({
        ok: false,
        stage: "env",
        error: "Missing OPENAI_API_KEY (or OPEN_API_KEY)"
      });
    }

    // 2) Minimal ping till OpenAI (bekräftar att nyckeln funkar)
    const ping = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }]
    });

    // 3) Allt grönt
    return res.status(200).json({
      ok: true,
      reply: ping?.choices?.[0]?.message?.content ?? null,
      node: process.versions.node
    });
  } catch (e) {
    // Skicka tillbaka exakt fel så vi ser vad som saknas
    return res.status(500).json({
      ok: false,
      stage: "openai_call",
      error: String(e),
      stack: e?.stack
    });
  }
}
