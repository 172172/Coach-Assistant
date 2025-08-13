// /api/db.js
import { Pool } from "pg";

function hasPgEnv() {
  return !!(process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD);
}

let pool = null;
if (hasPgEnv()) {
  pool = new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 6543, // 5432 om du inte kör pgbouncer
    database: process.env.PGDATABASE || "postgres",
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: { require: true, rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: Number(process.env.PG_IDLE || 10000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 10000),
  });
  pool.on("error", err => console.error("[pg] Pool error:", err?.message || err));
  console.log("[db] Mode=pg-pool host=%s port=%s", process.env.PGHOST, process.env.PGPORT || 6543);
} else {
  console.log("[db] Mode=supabase-js (no PG* env found)");
}

export async function q(text, params) {
  if (!pool) throw new Error("pg not configured");
  const client = await pool.connect();
  try { return await client.query(text, params); } finally { client.release(); }
}

// Lazy import för supabase-js (bara om SUPABASE_* finns)
export async function getSupa() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }});
}
