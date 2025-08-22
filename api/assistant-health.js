// /api/assistant-health.js  — ESM (funka med "type":"module")
import OpenAI from "openai";

const API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY; // fallback om du råkat döpa env annorlunda
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

const client = new OpenAI({ apiKey: API_KEY });

export default async function handler(req, res) {
  try {
    // 0) Snabb env-koll
    if (!API_KEY)      return res.status(500).json({ ok:false, stage:"env", error:"Missing OPENAI_API_KEY (or OPEN_API_KEY)" });
    if (!ASSISTANT_ID) return res.status(500).json({ ok:false, stage:"env", error:"Missing ASSISTANT_ID" });
    if (!VECTOR_STORE_ID) return res.status(500).json({ ok:false, stage:"env", error:"Missing VECTOR_STORE_ID" });

    // 1) Ping modellen (bekräftar att nyckeln kan göra anrop)
    const ping = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });

    // 2) Läs assistenten
    const asst = await client.beta.assistants.retrieve(ASSISTANT_ID);
    const toolTypes = (asst.tools || []).map(t => t.type);
    const hasFileSearch = toolTypes.includes("file_search");

    // 3) Läs vector store
    const vs = await client.beta.vectorStores.retrieve(VECTOR_STORE_ID);
    // file_counts: { in_progress, completed, cancelled, failed, total }
    const fileCounts = vs.file_counts || {};

    // 4) Lista filer (första 100) + ev. senaste fel
    const files = await client.beta.vectorStores.files.list(VECTOR_STORE_ID, { limit: 100 });
    const fileList = (files.data || []).map(f => ({
      id: f.id,
      status: f.status,            // "completed" | "in_progress" | "failed"
      last_error: f.last_error || null,
    }));

    // 5) Hämta kopplade vector stores på assistenten (kan vara tomt om du bara binder på run/thread)
    //    OBS: Även om denna lista är tom kan du binda din store per thread/run i koden.
    const attachedStores =
      asst.tool_resources?.file_search?.vector_store_ids || [];

    return res.status(200).json({
      ok: true,
      node: process.versions.node,
      ping_reply: ping?.choices?.[0]?.message?.content ?? null,

      assistant: {
        id: asst.id,
        name: asst.name || null,
        model: asst.model || null,
        tools: toolTypes,
        has_file_search: hasFileSearch,
        attached_vector_stores: attachedStores, // kan vara tom
      },

      vector_store: {
        id: vs.id,
        name: vs.name || null,
        file_counts: fileCounts,
      },

      files: fileList,
      tips: hasFileSearch ? [] : [
        "Assistant saknar 'file_search' i tools – slå på File Search i Assistants Console.",
      ],
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      stage: "health",
      error: String(e),
      stack: e?.stack,
    });
  }
}
