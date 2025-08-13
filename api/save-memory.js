// /api/save-memory.js
import { createClient } from '@supabase/supabase-js';
export const config = { api: { bodyParser: true } };

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST' });
  try {
    const { userId = 'kevin', key, value } = req.body || {};
    if (!key || !value) return res.status(400).json({ error: 'Missing key/value' });

    // enkel upsert (anpassa till din user_memory-layout)
    const { data: existing } = await supa.from('user_memory').select('id').eq('user_id', userId).eq('key', key).limit(1);
    if (existing?.length) {
      await supa.from('user_memory').update({ value, updated_at: new Date().toISOString() }).eq('id', existing[0].id);
    } else {
      await supa.from('user_memory').insert({ user_id: userId, key, value });
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
