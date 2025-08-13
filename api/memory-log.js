import { q, getSupa } from "./db.js";
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST" });
  try {
    const { conversation_id, role, content, modality = "voice", payload = null } = req.body || {};
    if (!conversation_id || !role) return res.status(400).json({ error: "Missing conversation_id/role" });

    const supa = await getSupa();
    if (supa) {
      const { error } = await supa.from("messages").insert({
        conversation_id, role, content: content ?? "", modality, payload
      });
      if (error) throw error;
      return res.status(200).json({ ok: true, mode: "supabase" });
    }

    await q(
      `insert into public.messages (conversation_id, role, content, modality, payload)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [conversation_id, role, content ?? "", modality, payload ? JSON.stringify(payload) : null]
    );
    res.status(200).json({ ok: true, mode: "pg" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
