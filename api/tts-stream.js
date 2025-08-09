// /api/tts-stream.js
// Streama ElevenLabs-ljud korrekt i Node-miljö (Web ReadableStream → res.write).
// Med fallback till icke-stream om något strular.

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false, // låt oss streama fritt
  },
};

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Only GET allowed" });
    }

    const { text = "", latency = "3" } = req.query || {};
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId =
      process.env.ELEVENLABS_VOICE_ID || "3mwblJqg1SFnILqt4AFC"; // din svenska röst

    if (!apiKey) {
      return res.status(500).json({ error: "ELEVENLABS_API_KEY saknas" });
    }

    const streamUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=${encodeURIComponent(
      latency
    )}&output_format=mp3_44100_128`;

    const payload = {
      text: String(text || "Okej."),
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.35,        // mer uttryck
        similarity_boost: 0.9,
        style: 0.75,            // piggare
        use_speaker_boost: true
      },
    };

    let upstream;
    try {
      upstream = await fetch(streamUrl, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return res
        .status(502)
        .json({ error: "Kunde inte nå TTS-leverantören", details: String(e) });
    }

    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(() => "");
      return res
        .status(500)
        .json({ error: "TTS stream error", details: errTxt || upstream.statusText });
    }

    // Försök streama via Web ReadableStream → Node response
    res.setHeader("Content-Type", "audio/mpeg");
    try {
      const body = upstream.body;

      // Fall 1: Web ReadableStream med getReader()
      if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
        res.end();
        return;
      }

      // Fall 2: Node stream (om miljön ändå ger en sådan)
      if (body && typeof body.pipe === "function") {
        body.pipe(res);
        return;
      }

      // Fall 3: Ingen stream-API? Läs som buffer.
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
      return;
    } catch (streamErr) {
      // Fallback till icke-streamad TTS
      try {
        const nonStreamUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
        const up2 = await fetch(nonStreamUrl, {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (!up2.ok) {
          const t = await up2.text().catch(() => "");
          return res
            .status(500)
            .json({ error: "TTS fallback error", details: t || up2.statusText });
        }
        const buf2 = Buffer.from(await up2.arrayBuffer());
        res.setHeader("Content-Type", "audio/mpeg");
        res.end(buf2);
      } catch (e2) {
        console.error("tts-stream fallback error:", e2);
        res
          .status(500)
          .json({ error: "Serverfel i tts-stream", details: e2?.message || String(e2) });
      }
    }
  } catch (e) {
    console.error("tts-stream error:", e);
    res
      .status(500)
      .json({ error: "Serverfel i tts-stream", details: e?.message || String(e) });
  }
}
