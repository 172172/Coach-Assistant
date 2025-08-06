export default async function handler(req, res) {
  const { text } = req.body;

  const voiceId = "3mwblJqg1SFnILqt4AFC"; // ← Din svenska röst
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const ssmlText = `<speak><lang xml:lang="sv-SE">${text}</lang></speak>`;

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey
    },
    body: JSON.stringify({
      model_id: "eleven_turbo_v2",
      text: ssmlText,
      // 👇 Förbättrade röstinställningar för mjuk, tydlig AI-röst
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.9,
        style: 0.3,
        use_speaker_boost: true
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
