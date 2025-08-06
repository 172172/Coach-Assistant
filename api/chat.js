export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Only POST requests allowed" });
  }

  const { message, knowledge } = req.body;

  const systemPrompt = `
Du är en professionell mentorassistent för Linje 65. 
Du svarar bara på frågor kopplade till sortbyten, felkoder, instruktioner och problem som kan uppstå för operatörer på linjen. 
Svara alltid kort, tydligt, professionellt och på svenska.

Din tillgängliga kunskap är följande:\n\n${knowledge}
`.trim();

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        temperature: 0.4
      }),
    });

    const data = await response.json();

    res.status(200).json({ reply: data.choices[0].message.content });
  } catch (err) {
    console.error("Fel vid API-anrop:", err);
    res.status(500).json({ reply: "Ett fel uppstod vid kommunikation med GPT." });
  }
}
