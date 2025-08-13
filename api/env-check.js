 export default async function handler(req, res) {
  const E = process.env;
  const mask = v => (v ? v.slice(0, 3) + "…"+ v.slice(-3) : null);
  return res.status(200).json({
    PGHOST: E.PGHOST || null,
    PGPORT: E.PGPORT || null,
    PGDATABASE: E.PGDATABASE || null,
    PGUSER_masked: mask(E.PGUSER),
    PGPASSWORD_len: E.PGPASSWORD ? E.PGPASSWORD.length : 0,
    OPENAI_API_KEY: E.OPENAI_API_KEY ? "set" : "missing",
    LOG_CONVO: E.LOG_CONVO ?? "0",
    node: process.version
  });
}
