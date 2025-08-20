import { Pool } from "pg";
export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT ?? 6543),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { require: true, rejectUnauthorized: false },
  max: 3, // liten pool för serverless
});
export async function q(sql, params=[]) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}
