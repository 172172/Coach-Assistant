// Node (Vercel Serverless). Hybrid-sök + normalisering + kontextklippning.
import { pool } from './db.js';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function normalizeSv(q){
  return q.toLowerCase()
    .replace(/\b(eeh|öh|typ|liksom|asså|ba|va|fan|eh)\b/g,' ')
    .replace(/\s+/g,' ')
    .replace(/linje\s*65/g,'linje65')
    .replace(/trettio[\-\s]?tre(?:\s*cl| centiliter)?/g,'33 cl')
    .trim();
}

export default async function handler(req, res){
  try{
    const { query, session } = await req.json?.() || await req.body?.json?.() || await req;
    const qRaw = (query||'').slice(0, 800);
    const q = normalizeSv(qRaw);

    // 1) Embedding på frågan (multilingual & robust)
    const emb = await openai.embeddings.create({ model:'text-embedding-3-large', input:q });
    const vec = emb.data[0].embedding;

    // 2) Dense (pgvector) + 3) BM25 (tsvector swedish)
    const client = await pool.connect();
    try{
      const topK = 5;
      const dense = await client.query(
        `SELECT id, title, section, content, 1 - (embedding <=> cube($1)) AS sim
         FROM manual_chunks
         ORDER BY embedding <=> cube($1)
         LIMIT $2`, [vec, topK]
      );

      const bm25 = await client.query(
        `SELECT id, title, section, content, ts_rank(tsv, plainto_tsquery('swedish', $1)) AS sim
         FROM manual_chunks
         WHERE tsv @@ plainto_tsquery('swedish', $1)
         ORDER BY sim DESC
         LIMIT $2`, [q, topK]
      );

      // 4) Merge + enkel rerank (dense 0.6 + keyword 0.4)
      const mergeMap = new Map();
      const push = (r, kind) => {
        const k = r.id;
        const prev = mergeMap.get(k) || { ...r, score:0 };
        const kwBoost = /(linje65|ocme|jones|33\s?cl|50\s?cl|cip|tapp|pastör)/.test(r.content.toLowerCase()) ? 1 : 0;
        const base = (r.sim||0);
        prev.score = Math.max(prev.score, 0.6*base + 0.4*kwBoost);
        mergeMap.set(k, prev);
      };
      dense.rows.forEach(r=>push(r,'dense'));
      bm25.rows.forEach(r=>push(r,'bm25'));

      let merged = Array.from(mergeMap.values()).sort((a,b)=>b.score-a.score).slice(0,4);

      // 5) Threshold + klipp kontext
      const TH = 0.28;
      if(!merged.length || merged[0].score < TH){
        return new Response(JSON.stringify({ chunks:[], notice:'low_similarity' }), { headers:{'Content-Type':'application/json'} });
      }

      const chunks = merged.map(r=>({
        id: r.id,
        ref: `${r.title} > ${r.section} > #${r.id}`,
        snippet: (r.content||'').slice(0, 1200)
      }));

      return new Response(JSON.stringify({
        query:qRaw,
        normalized:q,
        session,
        chunks
      }), { headers:{'Content-Type':'application/json'} });

    } finally { client.release(); }
  } catch (e){
    return new Response(JSON.stringify({ error:String(e) }), { status:500, headers:{'Content-Type':'application/json'} });
  }
}
