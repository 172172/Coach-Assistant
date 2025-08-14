import { q } from "./db.js";
export default async function handler(req, res) {
  try {
    const { conversation_id, role, content, modality, payload } = req.body || {};
    await q(
      `insert into messages (conversation_id, role, content, modality, raw)
       values ($1,$2,$3,$4,$5)`,
      [conversation_id, role, content, modality || 'voice', payload ? JSON.stringify(payload) : null]
    );
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
}
