// /api/memory-init.js
import { q } from "./db.js";

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  try {
    const { userId = "kevin", reviveMinutes = 90 } = req.body || {};

    // hämta senaste aktiva conv
    const recent = await q(
      `select * from conversations
        where user_id = $1 and status = 'active'
        order by started_at desc
        limit 1`,
      [userId]
    );
    let conv = recent.rows[0] || null;
    if (conv) {
      const ageMin = (Date.now() - new Date(conv.started_at).getTime()) / 60000;
      if (ageMin > reviveMinutes) conv = null;
    }

    // skapa ny om ingen nylig aktiv
    if (!conv) {
      const ins = await q(
        `insert into conversations (user_id, title)
         values ($1, 'Linje65 – Realtime')
         returning *`,
        [userId]
      );
      conv = ins.rows[0];
    }

    // senaste 16 meddelanden för bootstrap
    const msgs = await q(
      `select role, content, modality, created_at
         from messages
        where conversation_id = $1
        order by created_at desc
        limit 16`,
      [conv.id]
    );

    const recentPairs = msgs.rows
      .reverse()
      .map(m => `${m.role.toUpperCase()}: ${m.content || ""}`)
      .join("\n");

    const memoryBootstrap = `
[Sammanfattning hittills]
${conv.summary || "(tom)"}

[Senaste växlingar]
${recentPairs || "(inga)"}
`;

    res.status(200).json({ ok: true, conversation_id: conv.id, memoryBootstrap });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
