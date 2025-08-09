// /api/db.js
import { Pool } from "pg";

const cs = process.env.DATABASE_URL;

// Om du hellre satt PGHOST/PGPORT/… i Vercel så används de, annars DATABASE_URL.
// Viktigt: ssl.rejectUnauthorized = false
const pool = cs
  ? new Pool({
      connectionString: cs,
      ssl: { require: true, rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 6543,
      database: process.env.PGDATABASE || "postgres",
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: { require: true, rejectUnauthorized: false },
    });

export async function q(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}
