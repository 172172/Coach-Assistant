// /api/pg-env-check.js
export default async function handler(req, res) {
  res.status(200).json({
    PGHOST: process.env.PGHOST,
    PGPORT: process.env.PGPORT,
    PGDATABASE: process.env.PGDATABASE,
    PGUSER: process.env.PGUSER,
    PGSSLMODE: process.env.PGSSLMODE,
  });
}
