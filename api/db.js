// /api/db.js
import { Pool } from "pg";

// Bygg konfig från miljövariabler
function buildPgConfig() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";
  if (url) {
    return {
      connectionString: url,
      ssl: { require: true, rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: Number(process.env.PG_IDLE || 10000),
      connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 10000),
    };
  }
  // separat-variabler (din nuvarande stil)
  return {
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 6543, // 6543 = pgbouncer, 5432 = direkt
    database: process.env.PGDATABASE || "postgres",
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: { require: true, rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: Number(process.env.PG_IDLE || 10000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 10000),
  };
}

const cfg = buildPgConfig();
const pool = new Pool(cfg);

// Logga kopplingsinfo (maskat) så vi ser vad som händer i Vercel-loggar
(function logBootInfo() {
  const h = cfg.host ?? (cfg.connectionString ? new URL(cfg.connectionString).hostname : "n/a");
  const p = cfg.port ?? (cfg.connectionString ? (new URL(cfg.connectionString).port || "5432") : "n/a");
  const u = cfg.user ?? (cfg.connectionString ? decodeURIComponent(new URL(cfg.connectionString).username || "") : "");
  console.log(`[pg] init host=${h} port=${p} db=${cfg.database || "via-URL"} user=${u}`);
})();
pool.on("error", (err) => {
  console.error("[pg] Pool error:", err?.message || err);
});

export async function q(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Hjälp-funktion för hälsokontroll
export async function ping() {
  try { await q("select 1"); return true; } catch { return false; }
}
