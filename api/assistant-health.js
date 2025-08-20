// Hälsokoll: visar om assistenten har file_search på, vilka vector stores som är kopplade
// och status för filer i din VECTOR_STORE_ID.
import OpenAI from 'openai';

export const config = { runtime: 'nodejs' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

export default async function handler() {
  try {
    const report = { ok: true, assistant: null, tools: [], vector_store: null, files: [] };

    if (!ASSISTANT_ID) return new Response(JSON.stringify({ ok:false, error:'Missing ASSISTANT_ID' }), { status:500 });
    if (!VECTOR_STORE_ID) return new Response(JSON.stringify({ ok:false, error:'Missing VECTOR_STORE_ID' }), { status:500 });

    // 1) Läs assistentens inställningar
    const asst = await openai.beta.assistants.retrieve(ASSISTANT_ID);
    report.assistant = { id: asst.id, name: asst.name || null };
    report.tools = (asst.tools || []).map(t => t.type);

    // 2) Läs vector store
    const vs = await openai.beta.vectorStores.retrieve(VECTOR_STORE_ID);
    report.vector_store = { id: vs.id, name: vs.name || null, file_counts: vs.file_counts };

    // 3) Lista filer i store (första 50)
    const files = await openai.beta.vectorStores.files.list(VECTOR_STORE_ID, { limit: 50 });
    report.files = (files.data || []).map(f => ({
      id: f.id,
      status: f.status,
      last_error: f.last_error || null
    }));

    return new Response(JSON.stringify(report, null, 2), { headers: { 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error:String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
