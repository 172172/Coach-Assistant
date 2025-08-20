// Vercel Serverless (Node runtime)
import OpenAI from "openai";

export const config = { runtime: "nodejs" };
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID;

// Hjälp: plocka ut ren text från assistantens senaste meddelande
function extractTextAndCitations(messages) {
  const last = messages.data?.find(m => m.role === "assistant") || messages.data?.[0];
  let answer = "";
  const citations = [];

  if (!last) return { answer: "", citations };

  for (const c of last.content || []) {
    if (c.type === "text") {
      answer += c.text?.value || "";
      // annotations kan innehålla filreferenser
      for (const a of c.text?.annotations || []) {
        if (a?.file_citation?.file_id) {
          citations.push({
            file_id: a.file_citation.file_id,
            quote: a.file_citation.quote || ""
          });
        }
      }
    }
  }
  return { answer, citations };
}

export default async function handler(req, res) {
  try {
    const { query, thread_id: incomingThreadId, context } = await req.json?.() || await req.body?.json?.();
    if (!query) {
      return new Response(JSON.stringify({ error: "Missing query" }), { status: 400 });
    }

    // 1) Skapa (eller återanvänd) thread
    let threadId = incomingThreadId;
    if (!threadId) {
      const thread = await openai.beta.threads.create({
        // Valfritt: seed context (t.ex. current_line=65)
        tool_resources: {}, // lämna tomt – files är redan kopplade till assistenten
      });
      threadId = thread.id;
    }

    // 2) Lägg till användarens fråga som meddelande i tråden
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Fråga (svenska): ${query}\n` +
            `Policy: Svara ENDAST utifrån dina kopplade filer. Säg "Oklar information – behöver uppdaterad manual" om underlag saknas.\n` +
            (context?.current_line ? `current_line=${context.current_line}\n` : "")
        }
      ]
    });

    // 3) Kör en Run på assistenten och vänta tills klar
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: ASSISTANT_ID,
      // Addendum-instruktioner per fråga är kraftfullt för routing/filtrering
      additional_instructions:
        (context?.current_line ? `Prioritera information för linje ${context.current_line}. ` : "") +
        `Citat: inkludera filreferens/sektion när du anger exakta värden.`
    });

    // Polla tills completed (enkel polling)
    let runStatus = run;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250)); // ~10 s max
      runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      if (runStatus.status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(runStatus.status)) break;
    }

    if (runStatus.status !== "completed") {
      return new Response(JSON.stringify({
        answer: "",
        citations: [],
        thread_id: threadId,
        notice: `run_status=${runStatus.status}`
      }), { headers: { "Content-Type": "application/json" } });
    }

    // 4) Hämta meddelanden och plocka ut svar + citat
    const messages = await openai.beta.threads.messages.list(threadId, { order: "desc", limit: 5 });
    const { answer, citations } = extractTextAndCitations(messages);

    return new Response(JSON.stringify({
      answer,
      citations,
      thread_id: threadId
    }), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
