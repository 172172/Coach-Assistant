// api/tts.js
export default async function handler(req, res) {
  const { text } = req.body;

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "tts-1-hd",
      input: text,
      voice: "nova", // Eller "shimmer", "echo" osv
    }),
  });

  const arrayBuffer = await response.array
