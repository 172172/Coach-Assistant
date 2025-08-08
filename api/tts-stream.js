// /api/tts-stream.js
// Streamar TTS från ElevenLabs vidare till klienten för ultra-låg latens.

import { Readable } from "stream";

export default async function handler(req, res) {
  try {
    const text = (req.query?.text || "").toString();
    const latency = Number(req.query?.latency ?? 3); // 0..4 (högre = lägre latens, ev. mer "choppy")
    if (!text) {
      return res.status(400).json({ error: "Missing ?text query param" });
    }

    const voiceId = "3mwblJqg1SFnILqt4AFC"; // din svenska röst
    const apiKey = process.env.ELEVENLABS_API_KEY;

    // Liten, snabb stream för tal (bra balans för samtal, byt om du vill ha högre kvalitet)
    const streamUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=${latency}&output_format=mp3_22050_32`;

    // Neutral/proffsig ton – justera om du vill
    const voice_settings = {
      stability: 0.6,
      similarity_boost: 0.9,
      style: 0.2,
      use_speaker_boost: true
    };

    const upstream = await fetch(streamUrl, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: "eleven_multilingual_v2",
        text,
        voice_settings
      })
    });

    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(() => "");
      return res.status(502).json({ error: "Upstream TTS error", details: errTxt || upstream.statusText });
    }

    // Streama binärt vidare
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Transfer-Encoding", "chunked");
    // Konvertera Web ReadableStream -> Node stream och pip:a
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on("error", (e) => {
      try { res.end(); } catch {}
    });
    nodeStream.pipe(res);
  } catch (e) {
    console.error("tts-stream error:", e);
    return res.status(500).json({ error: "Serverfel i tts-stream", details: e.message || String(e) });
  }
}
