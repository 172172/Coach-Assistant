// /api/memory-summarize.js
import { q } from "./db.js";

export const config = { api: { bodyParser: true } };

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const SUM_MODEL = "gpt-4o-mini";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });
  try {
    const { conversation_id } = req.body || {};
    if (!conversation_id) return res.status(400).json({ error: "Missing conversation_id" });

    const conv = await q(`select id, summary from conversations where id = $1`, [conversation_id]);
    const msgs = await q(
      `select role, content, created_at
         from messages
        where conversation_id = $1
        order by created_at asc
        limit 40`,
      [conversation_id]
    );

    const history = msgs.rows.map(m => `${m.role.toUpperCase()}: ${m.content || ""}`).join("\n");

    const prompt = `
Du är assistent. Gör en kort, faktabaserad sammanfattning för långtidsminne:
- Vad frågades? Vilka beslut? Vilka inställningar/nummer? Vem (om nämnt)?
- Skriv på svenska, punktlista, max ca 200 ord.
Tidigare sammanfattning:
${conv.rows[0]?.summary || "(tom)"}
---
Ny historik att integrera:
${history}
`;

    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: SUM_MODEL, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(500).json({ error: "OpenAI error", details: j });

    const newSummary = j.choices?.[0]?.message?.content?.trim() || "";
    await q(`update conversations set summary = $1 where id = $2`, [newSummary, conversation_id]);

    res.status(200).json({ ok: true, summary: newSummary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
