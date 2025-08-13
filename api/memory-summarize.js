// /api/memory-summarize.js
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: true } };

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const SUM_MODEL = 'gpt-4o-mini'; // snabb/billig, byta vid behov

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST' });
  try {
    const { conversation_id } = req.body || {};
    if (!conversation_id) return res.status(400).json({ error: 'Missing conversation_id' });

    // hämta conv + senaste 40 msgs
    const [{ data: conv }, { data: msgs }] = await Promise.all([
      supa.from('conversations').select('id, summary').eq('id', conversation_id).single(),
      supa.from('messages').select('role, content, created_at').eq('conversation_id', conversation_id).order('created_at', { ascending: true }).limit(40)
    ]);

    const history = msgs.map(m => `${m.role.toUpperCase()}: ${m.content || ''}`).join('\n');

    const prompt = `
Du är assistent. Gör en kort, faktabaserad sammanfattning för långtidsminne:
- Vad frågades? Vilka beslut? Vilka inställningar/nummer? Vem (om nämnt)? 
- Skriv på svenska, punktlista, max ~200 ord.
Tidigare sammanfattning (om någon):
${conv?.summary || '(tom)'}
---
Ny historik att integrera:
${history}
`;

    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SUM_MODEL, messages: [{ role: 'user', content: prompt }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(500).json({ error: 'OpenAI error', details: j });

    const newSummary = j.choices?.[0]?.message?.content?.trim() || '';
    await supa.from('conversations').update({ summary: newSummary }).eq('id', conversation_id);

    res.status(200).json({ ok: true, summary: newSummary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
