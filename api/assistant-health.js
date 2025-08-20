// Hälsokoll: visar att assistenten har file_search ON, att VECTOR_STORE_ID finns,
// och listar filstatus i din vector store.
import OpenAI from 'openai';

export const config = { runtime: 'nodejs' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

export default async function handler(req, res) {
  try {
    if (!ASSISTANT_ID) return res.status(500).json({ ok:false, error:'Missing ASSISTANT_ID env' });
    if (!VECTOR_STORE_ID) return res.status(500).json({ ok:false, error:'Missing VECTOR_STORE_ID env' });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok:false, error:'Missing OPENAI_API_KEY env' });

    const report = { ok: true, assistant: null, tools: [], vector_store: null, files: [] };

    // 1) Läs assistenten
    const asst = await openai.beta.assistants.retrieve(ASSISTANT_ID);
    report.assistant = { id: asst.id, name: asst.name || null };
    report.tools = (asst.tools || []).map(t => t.type);

    // 2) Läs vector store
    const vs = await openai.beta.vectorStores.retrieve(VECTOR_STORE_ID);
    report.vector_store = { id: vs.id, name: vs.name || null, file_counts: vs.file_counts };

    // 3) Lista filer i store
    const files = await openai.beta.vectorStores.files.list(VECTOR_STORE_ID, { limit: 50 });
    report.files = (files.data || []).map(f => ({
      id: f.id,
      status: f.status,
      last_error: f.last_error || null
    }));

    return res.status(200).json(report);
  } catch (e) {
    // Skicka tillbaka detaljer så vi ser exakt vad som kraschar i Vercel-loggarna
    return res.status(500).json({ ok:false, error: String(e), stack: e?.stack });
  }
}
