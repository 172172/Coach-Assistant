import { q } from "./db.js";
export default async function handler(req, res) {
  try {
    const userId = req.body?.userId || 'anonymous';
    const r = await q(`insert into conversations (user_id) values ($1) returning id`, [userId]);
    res.json({ ok:true, conversation_id: r.rows[0].id, memoryBootstrap: '' });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
}
