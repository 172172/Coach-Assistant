import { supa as _supa } from './db.js';

export const config2 = { api: { bodyParser: true } };

export async function handler2(req, res) {
  try {
    const { userId = 'kevin', reviveMinutes = 90 } = req.body || {};

    // 1) Leta aktiv conv
    let conv = null;
    const { data: recent, error: rerr } = await _supa
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(1);
    if (rerr) throw rerr;

    if (recent?.length) {
      const last = recent[0];
      const ageMin = (Date.now() - new Date(last.started_at).getTime()) / 60000;
      conv = (ageMin <= reviveMinutes) ? last : null;
    }

    if (!conv) {
      const { data: created, error: cerr } = await _supa
        .from('conversations')
        .insert({ user_id: userId, title: 'Linje65 – Realtime' })
        .select().single();
      if (cerr) throw cerr;
      conv = created;
    }

    // 2) Plocka summary + senaste 16 meddelanden
    const { data: msgs, error: merr } = await _supa
      .from('messages')
      .select('role, content, modality, created_at')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(16);
    if (merr) throw merr;

    const recentPairs = (msgs || []).reverse().map(m => `${m.role.toUpperCase()}: ${m.content || ''}`).join('\n');

    const memoryBootstrap = `\n[Sammanfattning hittills]\n${conv.summary || '(tom)'}\n\n[Senaste växlingar]\n${recentPairs || '(inga)'}\n`;

    res.status(200).json({ ok: true, conversation_id: conv.id, memoryBootstrap });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

// Exportera som default för Vercel route:
export { handler2 as default };
