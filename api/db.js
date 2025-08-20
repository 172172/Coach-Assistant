import pg from 'pg';

const { Pool } = pg;
export const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL ? { rejectUnauthorized:false } : undefined,
  max: 5
});

// manual_chunks schema (exempel):
// id serial primary key
// title text, section text, content text
// embedding cube   -- eller vector (anpassa ORDER BY)
// tsv tsvector GENERATED ALWAYS AS (to_tsvector('swedish', coalesce(title,'')||' '||coalesce(content,''))) STORED
