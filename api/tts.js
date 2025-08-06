// pages/api/tts.js
export default async function handler(req, res) {
  const { text } = req.body;

  const voiceId = "21m00Tcm4TlvDq8ikWAM"; // Rachel – fungerar bra för svenska
  const apiKey = process.env.ELEVENLABS_API_KEY;

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2", // ✅ Ny modell = bättre flyt
        voice_settings: {
          stability: 0.2, // Mindre variation, låter mer fokuserat
          similarity_boost: 1.0, // Högsta möjliga "naturlighet"
          style: 0.5,
          use_speaker_boost: true
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(500).send("TTS-fel från ElevenLabs: " + errorText);
    }

    const audioBuffer = await response.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    console.error("TTS-fel:", err);
    res.status(500).send("Internt fel vid TTS");
  }
}
