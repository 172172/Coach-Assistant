// /api/user-preference.js — spara icke-farliga preferenser per device_id
import { Pool } from 'pg';

export const config = { api: { bodyParser: true } };

const pool = global.pgPool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});
if (!global.pgPool) global.pgPool = pool;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Only POST' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body||{});
    const { device_id, brevity = 'short', language = 'sv', speech_rate = 'normal' } = b;
    if (!device_id) return res.status(422).json({ ok:false, error:'device_id required' });

    const q = `
      INSERT INTO public.user_prefs (device_id, brevity, language, speech_rate)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (device_id)
      DO UPDATE SET brevity=EXCLUDED.brevity, language=EXCLUDED.language, speech_rate=EXCLUDED.speech_rate
      RETURNING device_id, brevity, language, speech_rate, updated_at
    `;
    const r = await pool.query(q, [device_id, brevity, language, speech_rate]);
    return res.status(200).json({ ok:true, prefs: r.rows[0] });
  } catch (e) {
    console.error('user-preference error:', e);
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}

/*
Kör en gång i DB (Postgres):

CREATE TABLE IF NOT EXISTS public.user_prefs (
  device_id text PRIMARY KEY,
  brevity text NOT NULL DEFAULT 'short',     -- short | normal | detailed
  language text NOT NULL DEFAULT 'sv',
  speech_rate text NOT NULL DEFAULT 'normal',
  updated_at timestamptz NOT NULL DEFAULT now()
);
*/
