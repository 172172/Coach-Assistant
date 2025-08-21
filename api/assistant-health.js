import OpenAI from "openai";

const API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY; // fallback om du råkat döpa annorlunda
const client = new OpenAI({ apiKey: API_KEY });

export default async function handler(req, res) {
  try {
    if (!API_KEY) return res.status(500).json({ ok:false, error:"Missing OPENAI_API_KEY/OPEN_API_KEY env" });

    // Minimal ping för att bekräfta att nyckeln funkar
    const r = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });

    return res.status(200).json({
      ok: true,
      reply: r?.choices?.[0]?.message?.content ?? null,
      node: process.versions.node
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e), stack:e?.stack });
  }
}
