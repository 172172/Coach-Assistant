// Serverless-brygga: tar emot query (+ ev. thread_id), kör Assistants File Search och returnerar svar + citat
import OpenAI from 'openai';

export const config = { runtime: 'nodejs' };
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY1 }); // OBS: använder OPENAI_API_KEY1
const ASSISTANT_ID = process.env.ASSISTANT_ID;

function extractTextAndCitations(messages) {
  // Hämta senaste assistant-svaret
  const last = messages.data?.find(m => m.role === 'assistant') || messages.data?.[0];
  let answer = '';
  const citations = [];
  if (!last) return { answer, citations };

  for (const c of last.content || []) {
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

function normalizeSv(q){
  return String(q||'').toLowerCase()
    .replace(/\b(eeh|öh|typ|liksom|asså|ba|va|fan|eh)\b/g,' ')
    .replace(/\s+/g,' ')
    .replace(/linje\s*65/g,'linje65')
    .replace(/trettio[\-\s]?tre(?:\s*cl| centiliter)?/g,'33 cl')
    .trim();
}

export default async function handler(req) {
  try {
    const { query, thread_id: incomingThreadId, context } = await req.json();
    if (!ASSISTANT_ID) return new Response(JSON.stringify({ error: 'Missing ASSISTANT_ID' }), { status: 500 });
    if (!query) return new Response(JSON.stringify({ error: 'Missing query' }), { status: 400 });

    const q = normalizeSv(query).slice(0, 800);

    // 1) Skapa/återanvänd tråd
    let threadId = incomingThreadId;
    if (!threadId) {
      const thread = await openai.beta.threads.create({ tool_resources: {} });
      threadId = thread.id;
    }

    // 2) Lägg till frågan som user-meddelande
    await openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `Fråga (svenska): ${q}\n` +
            `Policy: Svara ENDAST utifrån dina kopplade filer. Säg "Oklar information – behöver uppdaterad manual" om underlag saknas.\n` +
            (context?.current_line ? `current_line=${context.current_line}\n` : '')
        }
      ]
    });

    // 3) Starta en Run och vänta tills completed
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: ASSISTANT_ID,
      additional_instructions:
        (context?.current_line ? `Prioritera information för linje ${context.current_line}. ` : '') +
        `Citat: inkludera filreferens/sektion när du anger exakta värden.`
    });

    let runStatus = run;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250)); // ~10s max
      runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      if (runStatus.status === 'completed') break;
      if ([ 'failed','cancelled','expired' ].includes(runStatus.status)) break;
    }

    if (runStatus.status !== 'completed') {
      return new Response(JSON.stringify({
        answer: '', citations: [], thread_id: threadId, notice: `run_status=${runStatus.status}`
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 4) Läs ut svaret + citat
    const messages = await openai.beta.threads.messages.list(threadId, { order: 'desc', limit: 5 });
    const { answer, citations } = extractTextAndCitations(messages);

    return new Response(JSON.stringify({ answer, citations, thread_id: threadId }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
