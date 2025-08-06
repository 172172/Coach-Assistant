export default async function handler(req, res) {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Ingen text angiven" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "tts-1-hd",
        input: text,
        voice: "nova", // Eller shimmer, fable, onyx
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("OpenAI TTS-fel:", error);
      return res.status(500).json({ error: "OpenAI TTS misslyckades" });
    }

    const buffer = await response.arrayBuffer();

    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Serverfel:", err);
    res.status(500).json({ error: "Serverfel vid generering av tal" });
  }
}
