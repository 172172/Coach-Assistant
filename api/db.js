// /api/db.js
import { Pool } from "pg";

// Använd enbart separata PG-variabler (pooler 6543) och stäng av cert-verifiering.
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 6543,
  database: process.env.PGDATABASE || "postgres",
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { require: true, rejectUnauthorized: false },
  max: 5,           // lagom för serverless
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

export async function q(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}
