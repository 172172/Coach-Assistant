// /api/greeting.js
import fetch from "node-fetch";

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  try {
    const now = new Date();
    const hour = now.getHours();
    const tod =
      hour < 6 ? "natten" :
      hour < 11 ? "morgonen" :
      hour < 14 ? "förmiddagen" :
      hour < 18 ? "eftermiddagen" :
      hour < 22 ? "kvällen" : "senkvällen";

    const system = `Du är en Jarvis-liknande assistent på svenska.
Säg en kort, energig men professionell hälsning (max 35 ord).
Tilltala användaren som "chefen".
Knyt an till tid på dygnet och "systemet är online".
Undvik emojis, undvik frågor. Ingen extra text, endast hälsningen.`;

    const user = `Tid på dygnet: ${tod}.
Stil: lugn pondus, Future Ops/AI-co-pilot.
Tema: "Systemet är online och redo".
Extra: en kort peppande rad om fokus/precision.`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type":"application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.8,
        max_tokens: 80,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(500).json({ error: "OpenAI error", details: j });

    const text = (j.choices?.[0]?.message?.content || "Välkommen tillbaka, chefen. Systemet är online och redo.").trim();
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: "Serverfel i /api/greeting", details: e?.message || String(e) });
  }
}
