// /api/tts.js
export default async function handler(req, res) {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "No text provided" });
    }

    const voiceId = "3mwblJqg1SFnILqt4AFC"; // din svenska röst
    const apiKey = process.env.ELEVENLABS_API_KEY;

    // Neutral, tydlig leverans (inte “pepp”)
    const voice_settings = {
      stability: 0.6,
      similarity_boost: 0.9,
      style: 0.2,
      use_speaker_boost: true
    };

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey
      },
      body: JSON.stringify({
        model_id: "eleven_multilingual_v2",
        text,
        voice_settings
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(500).json({ error: "TTS API error", details: error });
    }

    const audioBuffer = await response.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(audioBuffer));
  } catch (e) {
    console.error("tts.js error:", e);
    return res.status(500).json({ error: "Serverfel i tts.js", details: e.message || String(e) });
  }
}
