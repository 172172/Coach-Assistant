export default async function handler(req, res) {
  const { text } = req.body;

  const voiceId = "3mwblJqg1SFnILqt4AFC"; // ← Byt ut till din Voice ID
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey
    },
    body: JSON.stringify({
      model_id: "eleven_turbo_v2",
      text,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    return res.status(500).json({ error: "TTS API error", details: error });
  }

  const audioBuffer = await response.arrayBuffer();

  res.setHeader("Content-Type", "audio/mpeg");
  res.send(Buffer.from(audioBuffer));
}
