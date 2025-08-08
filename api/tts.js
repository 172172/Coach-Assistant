// /api/tts.js
export default async function handler(req, res) {
  try {
    const { text, tone = "cheerful" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "No text provided" });
    }

    const voiceId = "3mwblJqg1SFnILqt4AFC"; // din svenska röst
    const apiKey = process.env.ELEVENLABS_API_KEY;

    // Ton-presets: peppa upp -> lägre stability, högre style, lite lägre similarity
    const PRESETS = {
      cheerful:  { stability: 0.28, similarity_boost: 0.70, style: 0.90, use_speaker_boost: true },
      energetic: { stability: 0.18, similarity_boost: 0.65, style: 1.00, use_speaker_boost: true },
      neutral:   { stability: 0.50, similarity_boost: 0.90, style: 0.30, use_speaker_boost: true },
      calm:      { stability: 0.75, similarity_boost: 0.90, style: 0.15, use_speaker_boost: true }
    };
    const voice_settings = PRESETS[tone] || PRESETS.cheerful;

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
