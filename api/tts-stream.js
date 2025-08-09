// /api/tts-stream.js
// ElevenLabs streaming med piggare leverans (mer stil, mindre stabilitet = mer variation)

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Only GET allowed" });

    const { text = "", latency = "3" } = req.query || {};
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "3mwblJqg1SFnILqt4AFC"; // din svenska röst

    if (!apiKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY saknas" });

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=${encodeURIComponent(latency)}&output_format=mp3_44100_128`;

    const body = {
      text: String(text || "Okej."),
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.35,          // lägre = mer uttryck
        similarity_boost: 0.9,
        style: 0.75,              // lite mer “taggad”
        use_speaker_boost: true
      }
    };

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(()=> "");
      return res.status(500).json({ error: "TTS stream error", details: errTxt || upstream.statusText });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    // Proxy stream direkt till klienten
    upstream.body.pipe(res);
  } catch (e) {
    console.error("tts-stream error:", e);
    res.status(500).json({ error: "Serverfel i tts-stream", details: e?.message || String(e) });
  }
}
