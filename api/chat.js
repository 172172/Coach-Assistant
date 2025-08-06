export default async function handler(req, res) {
  const { message } = req.body;

  // Hämta dokumentet som innehåller kunskapen (t.ex. från GitHub Pages)
  const knowledgeRes = await fetch("https://172172.github.io/Coach-Assistant/assistant-knowledge.txt");
  const knowledge = await knowledgeRes.text();

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Du är en mentor och coach på en produktionslinje. Du pratar alltid lugnt, tydligt och pedagogiskt – som om du lär upp en ny operatör. Allt du säger ska baseras endast på följande dokumentation från arbetsplatsen:\n\n"""${knowledge}"""\n\nOm frågan inte finns med i dokumentet ska du svara: "Den informationen har jag tyvärr inte just nu."`,
        },
        {
          role: "user",
          content: message,
        },
      ],
    }),
  });

  const data = await response.json();
  res.status(200).json({ reply: data.choices[0].message.content });
}
