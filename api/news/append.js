// /api/news/append.js  (utan @supabase/supabase-js)
function allowCors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id, X-Admin-Token');
}

export default async function handler(req, res) {
  const json = (code, obj) => { res.status(code).setHeader('Content-Type','application/json'); res.end(JSON.stringify(obj)); };

  allowCors(req, res);
  if (req.method === 'OPTIONS') return json(200, { ok:true });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(405, { ok:false, error:'Method not allowed' });
  }

  const token = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return json(401, { ok:false, error:'Unauthorized' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok:false, error:'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { title = '', body: text, area = null, shift = null, tags = [], news_at = null, user_id = null, source = 'ui' } = body;

    if (!text || typeof text !== 'string' || text.trim().length < 3) {
      return json(400, { ok:false, error:'body (text) is required' });
    }

    const row = {
      title: title || null,
      body: text.trim(),
      area, shift,
      tags: Array.isArray(tags) ? tags : [],
      news_at: news_at ? new Date(news_at).toISOString() : new Date().toISOString(),
      user_id, source
    };

    const r = await fetch(`${SUPABASE_URL}/rest/v1/line_news`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(row)
    });

    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await r.json() : { error: await r.text() };

    if (!r.ok) return json(r.status, { ok:false, error: data?.message || data?.error || `HTTP ${r.status}` });

    return json(200, { ok:true, news: Array.isArray(data) ? data[0] : data });
  } catch (err) {
    return json(500, { ok:false, error: err?.message || 'Server error' });
  }
}
