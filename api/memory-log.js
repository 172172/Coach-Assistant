import { q } from "./db.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"POST only" });
  try {
    if (process.env.LOG_CONVO !== "1") return res.status(200).json({ ok:true, disabled:true });
    const { conversation_id, role, content, modality=null, payload=null } = req.body || {};
    if (!conversation_id || !role || !content) return res.status(400).json({ ok:false, error:"Missing fields" });
    await q(`insert into messages(conversation_id, role, content, modality, payload)
             values ($1,$2,$3,$4,$5)`, [conversation_id, role, content, modality, payload]);
    res.status(200).json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
}
