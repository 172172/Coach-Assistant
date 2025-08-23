// /api/ask-assistant.js (ESM)
// Brygga: tar emot query (+ ev. thread_id), kör Assistants (File Search) och
// returnerar { answer, citations, thread_id }. VECTOR_STORE_ID är VALFRI.

import OpenAI from "openai";

const API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID; // valfri – används om satt

// Viktigt för Assistants v2
const client = new OpenAI({
  apiKey: API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" },
});

function normalizeSv(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/\b(eeh|öh|typ|liksom|asså|ba|va|fan|eh)\b/g, " ")
    .replace(/\s+/g, " ")
    .replace(/linje\s*65/g, "linje65")
    .replace(/trettio[\-\s]?tre(?:\s*cl| centiliter)?/g, "33 cl")
    .trim();
}

function extractAnswerForRun(messages, runId) {
  const items = messages.data || [];
  const msg =
    items.find((m) => m.role === "assistant" && m.run_id === runId) ||
    items.find((m) => m.role === "assistant");

  let answer = "";
  const citations = [];
  if (!msg) return { answer, citations };

  for (const c of msg.content || []) {
    if (c.type === "text") {
      answer += c.text?.value || "";
      for (const a of c.text?.annotations || []) {
        if (a?.file_citation?.file_id) {
          citations.push({
            file_id: a.file_citation.file_id,
            quote: a.file_citation.quote || "",
          });
        }
      }
    }
  }
  return { answer, citations };
}

export default async function handler(req, res) {
  try {
    // Bas-env
    if (!API_KEY)
      return res
        .status(500)
        .json({ error: "Missing OPENAI_API_KEY/OPEN_API_KEY env" });
    if (!ASSISTANT_ID)
      return res.status(500).json({ error: "Missing ASSISTANT_ID env" });

    // Parsea body robust (stöder både Next API och “raw”)
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    if (!body || typeof body !== "object") {
      try {
        // om den finns (Edge/Request)
        body = await req.json?.();
      } catch {
        /* ignore */
      }
    }

    const { query, thread_id: incomingThreadId, context } = body || {};
    if (!query) return res.status(400).json({ error: "Missing query" });

    const q = normalizeSv(query).slice(0, 800);

    // 1) Skapa/uppdatera THREAD. Om VECTOR_STORE_ID finns: bind den på tråden.
    let threadId = incomingThreadId;
    if (!threadId) {
      const threadPayload = {};
      if (VECTOR_STORE_ID) {
        threadPayload.tool_resources = {
          file_search: { vector_store_ids: [VECTOR_STORE_ID] },
        };
      }
      const thread = await client.beta.threads.create(threadPayload);
      threadId = thread.id;
    } else if (VECTOR_STORE_ID) {
      // uppdatera existerande tråd med vår store om satt
      await client.beta.threads.update(threadId, {
        tool_resources: { file_search: { vector_store_ids: [VECTOR_STORE_ID] } },
      });
    }
    // OBS: Om VECTOR_STORE_ID inte finns, används de stores som redan är kopplade till själva assistenten (enligt din health ✅).

    // 2) Lägg till frågan
    await client.beta.threads.messages.create(threadId, {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Fråga (svenska): ${q}\n` +
            `Policy: Svara ENDAST utifrån dina kopplade filer. Säg "Oklar information – behöver uppdaterad manual" om underlag saknas.\n` +
            (context?.current_line ? `current_line=${context.current_line}\n` : ""),
        },
      ],
    });

    // 3) Starta RUN. Om VECTOR_STORE_ID finns: bind även på RUN; annars förlitar vi oss på assistentens kopplade store.
    const runPayload = {
      assistant_id: ASSISTANT_ID,
      additional_instructions:
        (context?.current_line
          ? `Prioritera information för linje ${context.current_line}. `
          : "") + `Citat: inkludera filreferens/sektion när du anger exakta värden.`,
    };
    if (VECTOR_STORE_ID) {
      runPayload.tool_resources = {
        file_search: { vector_store_ids: [VECTOR_STORE_ID] },
      };
    }

    let run = await client.beta.threads.runs.create(threadId, runPayload);

    // 4) Poll tills completed, med tydligare felrapport
    const started = Date.now();
    const TIMEOUT_MS = 20_000; // 20s
    const SLEEP_MS = 300;

    while (true) {
      if (Date.now() - started > TIMEOUT_MS) break;
      await new Promise((r) => setTimeout(r, SLEEP_MS));
      run = await client.beta.threads.runs.retrieve(threadId, run.id);

      if (run.status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(run.status)) break;

      // (Optional) hantera required_action här om du i framtiden vill stödja tools
    }

    if (run.status !== "completed") {
      return res.status(200).json({
        answer: "",
        citations: [],
        thread_id: threadId,
        notice: `run_status=${run.status}`,
        last_error: run.last_error ?? null,
      });
    }

    // 5) Hämta de senaste meddelandena och plocka ut svaret för just den runnen
    const messages = await client.beta.threads.messages.list(threadId, {
      order: "desc",
      limit: 10,
    });
    const { answer, citations } = extractAnswerForRun(messages, run.id);

    return res.status(200).json({ answer, citations, thread_id: threadId });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e?.stack });
  }
}
