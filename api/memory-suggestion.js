// /api/memory-suggestion.js — ta emot förslag som ska granskas manuellt (ingen auto-inlärning)
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
    const {
      device_id, title, summary, suggested_text, risk_level,
      tags = [], evidence_snippets = [], user_utterance = ''
    } = b;

    if (!device_id || !title || !summary || !suggested_text || !risk_level) {
      return res.status(422).json({ ok:false, error:'Missing required fields' });
    }

    const q = `
      INSERT INTO public.knowledge_suggestions
        (device_id, title, summary, suggested_text, risk_level, tags, evidence, user_utterance, status)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,'pending')
      RETURNING id, created_at
    `;
    const vals = [device_id, title, summary, suggested_text, risk_level, JSON.stringify(tags), JSON.stringify(evidence_snippets), user_utterance];
    const r = await pool.query(q, vals);
    return res.status(200).json({ ok:true, id: r.rows[0].id, created_at: r.rows[0].created_at });
  } catch (e) {
    console.error('memory-suggestion error:', e);
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}

/*
Kör en gång i DB (Postgres):

CREATE TABLE IF NOT EXISTS public.knowledge_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  device_id text,
  title text NOT NULL,
  summary text NOT NULL,
  suggested_text text NOT NULL,
  risk_level text CHECK (risk_level IN ('low','medium','high')) NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  user_utterance text,
  status text NOT NULL DEFAULT 'pending' -- pending, approved, rejected
);
*/
