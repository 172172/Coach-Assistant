// /api/memory-init.js
import { q, getSupa } from "./db.js";
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  try {
    const { userId = "kevin", reviveMinutes = 90 } = req.body || {};
    const supa = await getSupa();

    if (supa) {
      // Supabase-vägen
      const { data: recent, error: rerr } = await supa
        .from("conversations").select("*")
        .eq("user_id", userId).eq("status", "active")
        .order("started_at", { ascending: false }).limit(1);
      if (rerr) throw rerr;

      let conv = recent?.[0] || null;
      if (conv) {
        const ageMin = (Date.now() - new Date(conv.started_at || conv.created_at || Date.now()).getTime()) / 60000;
        if (ageMin > reviveMinutes) conv = null;
      }
      if (!conv) {
        const { data: created, error: cerr } = await supa
          .from("conversations").insert({ user_id: userId, title: "Linje65 – Realtime" }).select().single();
        if (cerr) throw cerr;
        conv = created;
      }
      const { data: msgs, error: merr } = await supa
        .from("messages")
        .select("role, content, modality, created_at")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: false }).limit(16);
      if (merr) throw merr;

      const recentPairs = (msgs || []).reverse().map(m => `${m.role.toUpperCase()}: ${m.content || ""}`).join("\n");
      const memoryBootstrap = `\n[Sammanfattning hittills]\n${conv.summary || "(tom)"}\n\n[Senaste växlingar]\n${recentPairs || "(inga)"}\n`;
      return res.status(200).json({ ok: true, conversation_id: conv.id, memoryBootstrap, mode: "supabase" });
    }

    // PG-fallback
    const ORDER_COL = "coalesce(started_at, created_at, now())";
    const recent = await q(
      `select *, ${ORDER_COL} as started_at_fallback
         from conversations
        where user_id = $1 and status = 'active'
        order by ${ORDER_COL} desc
        limit 1`, [userId]
    );
    let conv = recent.rows[0] || null;
    if (conv) {
      const ts = conv.started_at || conv.started_at_fallback;
      const ageMin = (Date.now() - new Date(ts).getTime()) / 60000;
      if (ageMin > reviveMinutes) conv = null;
    }
    if (!conv) {
      const ins = await q(
        `insert into conversations (user_id, title)
         values ($1, 'Linje65 – Realtime')
         returning *`, [userId]
      );
      conv = ins.rows[0];
    }
    const msgs = await q(
      `select role, content, modality, created_at
         from messages
        where conversation_id = $1
        order by created_at desc
        limit 16`, [conv.id]
    );
    const recentPairs = msgs.rows.reverse().map(m => `${m.role.toUpperCase()}: ${m.content || ""}`).join("\n");
    const memoryBootstrap = `\n[Sammanfattning hittills]\n${conv.summary || "(tom)"}\n\n[Senaste växlingar]\n${recentPairs || "(inga)"}\n`;
    res.status(200).json({ ok: true, conversation_id: conv.id, memoryBootstrap, mode: "pg" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
