import OpenAI from "openai";

const API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

const client = new OpenAI({ apiKey: API_KEY });

export default async function handler(req, res) {
  try {
    if (!API_KEY) return res.status(500).json({ ok:false, stage:"env", error:"Missing OPENAI_API_KEY/OPEN_API_KEY" });
    if (!ASSISTANT_ID) return res.status(500).json({ ok:false, stage:"env", error:"Missing ASSISTANT_ID" });

    // 1) Ping modellen – bekräftar nyckeln
    const ping = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });

    // 2) Läs assistenten
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

    // 3) Vector Store-detaljer (om SDK:et stödjer det OCH du har ID)
    if (client?.beta?.vectorStores && VECTOR_STORE_ID) {
      try {
        const vs = await client.beta.vectorStores.retrieve(VECTOR_STORE_ID);
        result.vector_store = {
          id: vs.id,
          name: vs.name || null,
          file_counts: vs.file_counts || null,
        };

        const files = await client.beta.vectorStores.files.list(VECTOR_STORE_ID, { limit: 100 });
        result.files = (files.data || []).map(f => ({
          id: f.id,
          status: f.status,
          last_error: f.last_error || null,
        }));
      } catch (e) {
        result.vector_store = { id: VECTOR_STORE_ID, error: String(e) };
        result.tips.push("Vector store kunde inte läsas – kontrollera SDK-versionen och VECTOR_STORE_ID.");
      }
    } else if (!VECTOR_STORE_ID) {
      result.tips.push("Sätt VECTOR_STORE_ID om du vill få filstatus i health.");
    } else {
      result.tips.push("Din openai-version saknar beta.vectorStores – kör: npm i openai@latest");
    }

    if (!hasFileSearch) {
      result.tips.push("Assistant saknar 'file_search' – slå på File Search i Assistants Console.");
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ ok:false, stage:"health", error:String(e), stack:e?.stack });
  }
}
