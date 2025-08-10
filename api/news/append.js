// /api/news/append.js 
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function allowCors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id, X-Admin-Token');
}

export default async function handler(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Enkel låsning med admin-token
  const token = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const {
      title = '',
      body: text,
      area = null,
      shift = null,
      tags = [],
      news_at = null,
      user_id = null,
      source = 'ui'
    } = body;

    if (!text || typeof text !== 'string' || text.trim().length < 3) {
      return res.status(400).json({ ok: false, error: 'body (text) is required' });
    }

    const insert = {
      title: title || null,
      body: text.trim(),
      area,
      shift,
      tags: Array.isArray(tags) ? tags : [],
      news_at: news_at ? new Date(news_at).toISOString() : new Date().toISOString(),
      user_id,
      source
    };

    const { data, error } = await supabase
      .from('line_news')
      .insert(insert)
      .select()
      .single();

    if (error) throw error;

    return res.status(200).json({ ok: true, news: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
}
