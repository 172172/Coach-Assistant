// /api/memory-init.js
import { q } from "./db.js";

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  try {
    const { userId = "kevin", reviveMinutes = 90 } = req.body || {};

    // Använd en fallback-kolumn om started_at saknas ännu (coalesce)
    const ORDER_COL = "coalesce(started_at, created_at, now())";

    // 1) Hämta senaste aktiva conv
    const recent = await q(
      `select *, ${ORDER_COL} as started_at_fallback
         from conversations
        where user_id = $1 and status = 'active'
        order by ${ORDER_COL} desc
        limit 1`,
      [userId]
    );

    let conv = recent.rows[0] || null;

    // 2) Avgör om vi ska återanvända utifrån ålder (med fallback tidsstämpel)
    if (conv) {
      const ts = conv.started_at || conv.started_at_fallback; // robust
      const ageMin = (Date.now() - new Date(ts).getTime()) / 60000;
      if (ageMin > reviveMinutes) conv = null;
    }

    // 3) Skapa ny konversation om vi inte återanvänder
    if (!conv) {
      const ins = await q(
        `insert into conversations (user_id, title)
         values ($1, 'Linje65 – Realtime')
         returning *`,
        [userId]
      );
      conv = ins.rows[0];
    }

    // 4) Plocka senaste 16 meddelanden (för bootstrap-minne)
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
