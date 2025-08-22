// /api/assistant-health.js
import OpenAI from "openai";

const API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

const client = new OpenAI({ apiKey: API_KEY });

export default async function handler(req, res) {
  try {
    if (!API_KEY) return res.status(500).json({ ok:false, stage:"env", error:"Missing OPENAI_API_KEY/OPEN_API_KEY" });
    if (!ASSISTANT_ID) return res.status(500).json({ ok:false, stage:"env", error:"Missing ASSISTANT_ID" });

    const ping = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });

    const asst = await client.beta.assistants.retrieve(ASSISTANT_ID);
    const toolTypes = (asst.tools || []).map(t => t.type);
    const hasFileSearch = toolTypes.includes("file_search");
    const attachedStores = asst.tool_resources?.file_search?.vector_store_ids || [];

    const result = {
      ok: true,
      node: process.versions.node,
      ping_reply: ping?.choices?.[0]?.message?.content ?? null,
      assistant: {
        id: asst.id,
        name: asst.name || null,
        model: asst.model || null,
        tools: toolTypes,
        has_file_search: hasFileSearch,
        attached_vector_stores: attachedStores,
      },
      vector_store_api_available: Boolean(client?.beta?.vectorStores),
      vector_store: null,
      files: [],
      tips: [],
    };

    if (!hasFileSearch) result.tips.push("Assistant saknar 'file_search' – slå på File Search.");

    // Läs store + filer om SDK:et har API:t
    if (client?.beta?.vectorStores) {
      const storeId = VECTOR_STORE_ID || attachedStores[0];
      if (!storeId) {
        result.tips.push("Ingen VECTOR_STORE_ID satt och assistenten har ingen store kopplad.");
      } else {
        const vs = await client.beta.vectorStores.retrieve(storeId);
        result.vector_store = {
          id: vs.id,
          name: vs.name || null,
          file_counts: vs.file_counts || null,
        };

        const files = await client.beta.vectorStores.files.list(storeId, { limit: 100 });
        result.files = (files.data || []).map(f => ({
          id: f.id,
          status: f.status, // "completed" | "in_progress" | "failed"
          last_error: f.last_error || null,
        }));
      }
    } else {
      result.tips.push("Din openai-version saknar beta.vectorStores – uppgradera SDK (npm i openai@latest)");
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ ok:false, stage:"health", error:String(e), stack:e?.stack });
  }
}
