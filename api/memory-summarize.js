// /api/memory-summarize.js
import { q, getSupa } from "./db.js";
export const config = { api: { bodyParser: true } };

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const SUM_MODEL = "gpt-4o-mini";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });
  try {
    const { conversation_id } = req.body || {};
    if (!conversation_id) return res.status(400).json({ error: "Missing conversation_id" });

    const supa = await getSupa();
    let summaryBefore = "";
    let history = "";

    if (supa) {
      const [{ data: conv }, { data: msgs }] = await Promise.all([
        supa.from("conversations").select("id, summary").eq("id", conversation_id).single(),
        supa.from("messages").select("role,content,created_at").eq("conversation_id", conversation_id).order("created_at", { ascending: true }).limit(40)
      ]);
      summaryBefore = conv?.summary || "";
      history = (msgs || []).map(m => `${m.role.toUpperCase()}: ${m.content || ""}`).join("\n");
    } else {
      const conv = await q(`select id, summary from conversations where id = $1`, [conversation_id]);
      const msgs = await q(
        `select role, content, created_at from messages where conversation_id = $1 order by created_at asc limit 40`,
        [conversation_id]
      );
      summaryBefore = conv.rows[0]?.summary || "";
      history = msgs.rows.map(m => `${m.role.toUpperCase()}: ${m.content || ""}`).join("\n");
    }

    const prompt = `
Du är assistent. Gör en kort, faktabaserad sammanfattning för långtidsminne:
- Vad frågades? Vilka beslut? Vilka inställningar/nummer? Vem (om nämnt)?
- Skriv på svenska, punktlista, max ca 200 ord.
Tidigare sammanfattning:
${summaryBefore || "(tom)"}
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

    if (supa) {
      const { error } = await supa.from("conversations").update({ summary: newSummary }).eq("id", conversation_id);
      if (error) throw error;
      return res.status(200).json({ ok: true, summary: newSummary, mode: "supabase" });
    } else {
      await q(`update conversations set summary = $1 where id = $2`, [newSummary, conversation_id]);
      return res.status(200).json({ ok: true, summary: newSummary, mode: "pg" });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
