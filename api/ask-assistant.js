// Brygga: tar emot query (+ ev. thread_id), kör Assistants (File Search) och
// returnerar svar + citat. Node-stil svar (res.json) + robust felhantering.
import OpenAI from 'openai';

export const config = { runtime: 'nodejs' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

function normalizeSv(q){
  return String(q||'').toLowerCase()
    .replace(/\b(eeh|öh|typ|liksom|asså|ba|va|fan|eh)\b/g,' ')
    .replace(/\s+/g,' ')
    .replace(/linje\s*65/g,'linje65')
    .replace(/trettio[\-\s]?tre(?:\s*cl| centiliter)?/g,'33 cl')
    .trim();
}

function extractAnswerForRun(messages, runId){
  const items = messages.data || [];
  const msg = items.find(m => m.role === 'assistant' && m.run_id === runId) ||
              items.find(m => m.role === 'assistant');
  let answer = '';
  const citations = [];
  if (!msg) return { answer, citations };
  for (const c of msg.content || []) {
    if (c.type === 'text') {
      answer += c.text?.value || '';
      for (const a of c.text?.annotations || []) {
        if (a?.file_citation?.file_id) {
          citations.push({
            file_id: a.file_citation.file_id,
            quote: a.file_citation.quote || ''
          });
        }
      }
    }
  }
  return { answer, citations };
}

export default async function handler(req, res) {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY env' });
    if (!ASSISTANT_ID) return res.status(500).json({ error: 'Missing ASSISTANT_ID env' });
    if (!VECTOR_STORE_ID) return res.status(500).json({ error: 'Missing VECTOR_STORE_ID env' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { query, thread_id: incomingThreadId, context } = body;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const q = normalizeSv(query).slice(0, 800);

    // 1) Skapa/återanvänd tråd och BIND vector store på tråden
    let threadId = incomingThreadId;
    if (!threadId) {
      const thread = await openai.beta.threads.create({
        tool_resources: {
          file_search: { vector_store_ids: [VECTOR_STORE_ID] }
        }
      });
      threadId = thread.id;
    } else {
      await openai.beta.threads.update(threadId, {
        tool_resources: {
          file_search: { vector_store_ids: [VECTOR_STORE_ID] }
        }
      });
    }

    // 2) Lägg till frågan
    await openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: [{
        type: 'text',
        text:
          `Fråga (svenska): ${q}\n` +
          `Policy: Svara ENDAST utifrån dina kopplade filer. Säg "Oklar information – behöver uppdaterad manual" om underlag saknas.\n` +
          (context?.current_line ? `current_line=${context.current_line}\n` : '')
      }]
    });

    // 3) Run – BIND vector store även på run-nivå
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: ASSISTANT_ID,
      additional_instructions:
        (context?.current_line ? `Prioritera information för linje ${context.current_line}. ` : '') +
        `Citat: inkludera filreferens/sektion när du anger exakta värden.`,
      tool_resources: {
        file_search: { vector_store_ids: [VECTOR_STORE_ID] }
      }
    });

    // 4) Poll (≈5s)
    let runStatus = run;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      if (runStatus.status === 'completed') break;
      if (['failed','cancelled','expired'].includes(runStatus.status)) break;
    }

    if (runStatus.status !== 'completed') {
      return res.status(200).json({
        answer: '',
        citations: [],
        thread_id: threadId,
        notice: `run_status=${runStatus.status}`
      });
    }

    // 5) Hämta svaret för just denna run
    const messages = await openai.beta.threads.messages.list(threadId, { order: 'desc', limit: 10 });
    const { answer, citations } = extractAnswerForRun(messages, run.id);

    return res.status(200).json({ answer, citations, thread_id: threadId });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e?.stack });
  }
}
