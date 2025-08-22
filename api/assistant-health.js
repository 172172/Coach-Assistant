// /api/assistant-health.js
import OpenAI from "openai";

const API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

// Sätt Assistants v2-headern (krävs för nuvarande assistants API)
const client = new OpenAI({
  apiKey: API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" },
});

export default async function handler(req, res) {
  try {
    if (!API_KEY) {
      return res
        .status(500)
        .json({ ok: false, stage: "env", error: "Missing OPENAI_API_KEY/OPEN_API_KEY" });
    }
    if (!ASSISTANT_ID) {
      return res
        .status(500)
        .json({ ok: false, stage: "env", error: "Missing ASSISTANT_ID" });
    }

    // 1) Ping
    const ping = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });

    // 2) Hämta assistant
    const asst = await client.beta.assistants.retrieve(ASSISTANT_ID);
    const toolTypes = (asst.tools || []).map((t) => t.type);
    const hasFileSearch = toolTypes.includes("file_search");
    const attachedStores = asst.tool_resources?.file_search?.vector_store_ids || [];

    // 3) Feature-detect för Vector Stores (v5: client.vectorStores, äldre: client.beta.vectorStores)
    const vectorStoresApi =
      client.vectorStores || (client.beta && client.beta.vectorStores) || null;

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
      vector_store_api_available: Boolean(vectorStoresApi),
      vector_store: null,
      files: [],
      tips: [],
    };

    if (!hasFileSearch) {
      result.tips.push("Assistant saknar 'file_search' – slå på File Search i assistenten.");
    }

    // 4) Läs store + filer om Vector Store-API finns
    if (vectorStoresApi) {
      const storeId = VECTOR_STORE_ID || attachedStores[0];
      if (!storeId) {
        result.tips.push(
          "Ingen VECTOR_STORE_ID satt och assistenten har ingen Vector Store kopplad."
        );
      } else {
        const vs = await vectorStoresApi.retrieve(storeId);
        result.vector_store = {
          id: vs.id,
          name: vs.name || null,
          file_counts: vs.file_counts || null,
        };

        // list-signaturen är densamma i v5, bara namespace skiljer.
        const files = await vectorStoresApi.files.list(storeId, { limit: 100 });
        result.files = (files.data || []).map((f) => ({
          id: f.id,
          status: f.status, // "completed" | "in_progress" | "failed"
          last_error: f.last_error || null,
        }));
      }
    } else {
      result.tips.push(
        "Din OpenAI-SDK saknar vectorStores – uppgradera till v5 (t.ex. npm i openai@^5)."
      );
    }

    // 5) För extra transparens: visa SDK-version
    try {
      const pkg = await import("openai/package.json");
      result.openai_version = pkg.default?.version || pkg.version || null;
    } catch {
      // ignore
    }

    return res.status(200).json(result);
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, stage: "health", error: String(e), stack: e?.stack });
  }
}
