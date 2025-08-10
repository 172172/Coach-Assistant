// /api/tts-stream.js
// Streama ElevenLabs-ljud korrekt i Node-miljö (Web ReadableStream → res.write).
// Med robustare defaults + tunable query params för prosodi.

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Only GET allowed" });
    }

    // --- Query overrides ---
    const {
      text = "",
      // Lägre siffra = mer kvalitet/prosodi (lite högre latens), högre = snabbare/mer “klipp”
      latency = "1",                   // ändrat från "3" → mer naturligt läge som default
      model = "eleven_multilingual_v2",
      stability,
      similarity,
      style,
      boost,
      format // t.ex. mp3_44100_128, wav_44100 (valfritt)
    } = req.query || {};

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "3mwblJqg1SFnILqt4AFC";
    if (!apiKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY saknas" });

    const output_format = typeof format === "string" && format ? format : "mp3_44100_128";

    const streamUrl =
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
      `?optimize_streaming_latency=${encodeURIComponent(latency)}` +
      `&output_format=${encodeURIComponent(output_format)}`;

    // --- Voice settings: mer mänsklig default, men styrbart via query ---
    // Uppdatering: Lägre stability för naturlig variation (andning, tonfall), högre similarity och style för energi och mänsklighet
    const voice_settings = {
      // Lägre stability → mer variation och andning; höj om det blir för spretigt
      stability: clamp01(toNum(stability, 0.3)),  // Uppdaterat default för mer naturlig, Grok-lik variation
      // Hög similarity bevarar klonens karaktär
      similarity_boost: clamp01(toNum(similarity, 0.95)),  // Uppdaterat för bättre röstkaraktär
      // Stil/uttryck – ger mer energi/intonation
      style: clamp01(toNum(style, 0.85)),  // Uppdaterat för mer uttryck och levande intonation
      use_speaker_boost: toBool(boost, true)
    };

    // Liten slumpfaktor för variation per call (för att kännas mer mänskligt)
    voice_settings.stability = Math.max(0.25, Math.min(0.35, voice_settings.stability + (Math.random() * 0.1 - 0.05)));

    const payload = {
      text: String(text || "Okej."),
      model_id: String(model || "eleven_multilingual_v2"),
      voice_settings
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
      return res.status(502).json({ error: "Kunde inte nå TTS-leverantören", details: String(e) });
    }

    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(() => "");
      return res.status(500).json({ error: "TTS stream error", details: errTxt || upstream.statusText });
    }

    res.setHeader("Content-Type", mimeFromFormat(output_format));

    try {
      const body = upstream.body;

      // Web ReadableStream
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

      // Node stream
      if (body && typeof body.pipe === "function") {
        body.pipe(res);
        return;
      }

      // Buffer fallback
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
          return res.status(500).json({ error: "TTS fallback error", details: t || up2.statusText });
        }
        const buf2 = Buffer.from(await up2.arrayBuffer());
        res.setHeader("Content-Type", mimeFromFormat(output_format));
        res.end(buf2);
      } catch (e2) {
        console.error("tts-stream fallback error:", e2);
        res.status(500).json({ error: "Serverfel i tts-stream", details: e2?.message || String(e2) });
      }
    }
  } catch (e) {
    console.error("tts-stream error:", e);
    res.status(500).json({ error: "Serverfel i tts-stream", details: e?.message || String(e) });
  }
}

/* -------- helpers -------- */
function toNum(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function clamp01(x){ return Math.max(0, Math.min(1, Number(x)||0)); }
function toBool(v, dflt=true){
  if (v === undefined) return dflt;
  if (typeof v === "string") return ["1","true","yes","on"].includes(v.toLowerCase());
  return !!v;
}
function mimeFromFormat(fmt) {
  if (!fmt) return "audio/mpeg";
  if (fmt.startsWith("mp3")) return "audio/mpeg";
  if (fmt.startsWith("wav")) return "audio/wav";
  if (fmt.startsWith("pcm")) return "audio/basic";
  return "audio/mpeg";
}
