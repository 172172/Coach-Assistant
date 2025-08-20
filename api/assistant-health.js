// /api/assistant-health.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    // enkel health check mot modellen
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say 'healthy'" }],
    });

    res.status(200).json({ ok: true, message: response.choices[0].message.content });
  } catch (error) {
    console.error("Assistant health error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
}
