// /api/memory-log.js
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: true } };

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST' });
  try {
    const { conversation_id, role, content, modality = 'voice', payload = null } = req.body || {};
    if (!conversation_id || !role) return res.status(400).json({ error: 'Missing conversation_id/role' });

    const { error } = await supa.from('messages').insert({ conversation_id, role, content, modality, payload });
    if (error) throw error;

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
