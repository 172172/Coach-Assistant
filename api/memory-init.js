import { q } from "./db.js";
export default async function handler(req, res) {
  try {
    const user_id = "kevin"; // byt till något från cookie om du vill
    // hämta senaste conv
    const r = await q(`select id from conversations
                       where user_id=$1 order by created_at desc limit 1`, [user_id]);
    let id = r.rows[0]?.id;
    if (!id) {
      const ins = await q(`insert into conversations(user_id, started_at)
                           values ($1, now()) returning id`, [user_id]);
      id = ins.rows[0].id;
    }
    res.status(200).json({ ok:true, conversation_id:id });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
}
