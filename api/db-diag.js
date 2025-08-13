import { q } from "./db.js";

export default async function handler(req, res) {
  try {
    const out = {};
    out.identity = (await q(`select now(), current_user, current_database()`)).rows[0];

    // Extensions
    out.extensions = (await q(
      `select extname from pg_extension where extname in ('vector','pgcrypto') order by 1`
    )).rows.map(r => r.extname);

    // Finns tabellerna?
    const tables = await q(`
      select table_name
      from information_schema.tables
      where table_schema='public'
        and table_name in ('conversations','messages','manual_docs','manual_chunks')
      order by 1
    `);
    out.tables = tables.rows.map(r => r.table_name);

    // Snabb counts
    const counts = await q(`
      select 'conversations' as t, count(*)::int from conversations
      union all
      select 'messages', count(*)::int from messages
      union all
      select 'manual_docs', count(*)::int from manual_docs
      union all
      select 'manual_chunks', count(*)::int from manual_chunks
    `);
    out.counts = Object.fromEntries(counts.rows.map(r => [r.t, r.count]));

    // Visa en chunk om det finns data
    if ((out.counts.manual_chunks ?? 0) > 0) {
      out.sample_chunk = (await q(`
        select doc_id, idx, left(chunk, 180) as preview
        from manual_chunks
        order by doc_id, idx
        limit 1
      `)).rows[0];
    }

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
