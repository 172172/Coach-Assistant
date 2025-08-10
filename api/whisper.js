export const config = {
  api: { bodyParser: false },
};

import formidable from "formidable";
import fs from "fs";
import { promisify } from "util";
import fetch from "node-fetch";
import FormData from "form-data";

const readFile = promisify(fs.readFile);

function parseForm(req) {
  const form = formidable({ multiples: false, keepExtensions: true });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

// Stärkt domän-prompt: skriv in vanliga felhörningar/uttal
const DOMAIN_HINT = `
Carlsberg, Linje 65, tapp, pastör, depalletizer (uttalas "depallettisör"),
Kisters limaggregat (lim-station), OCME (uttalas "åsme"), Jones, Coolpack,
gejdrar (guideskenor), givare (sensor), fals (förslutning i burklinje),
6-pack, 20-pack, 24-pack, CIP (uttalas "cippa", "zippa", "sippa") = Cleaning-In-Place.
Om du hör "cippa", "zippa" eller "sippa", skriv "CIP".
Om du hör "åsme" eller "ocme", skriv "OCME".
Skriv tekniska ord som de stavas i manualen och undvik att gissa andra ord.
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const { files } = await parseForm(req);
    const uploaded = files.audio;
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;

    if (!file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    const filepath = file.filepath || file._writeStream?.path;
    if (!filepath) {
      return res.status(500).json({ error: "Serverfel i whisper.js", details: "No valid file path found" });
    }

    const audioData = await readFile(filepath);

    const formData = new FormData();
    formData.append("file", audioData, {
      filename:
        file.originalFilename ||
        (file.mimetype && file.mimetype.includes("mp4") ? "audio.m4a" : "audio.webm"),
      contentType: file.mimetype || "audio/webm",
    });
    formData.append("model", "whisper-1");
    formData.append("language", "sv");
    formData.append("temperature", "0");
    formData.append("prompt", DOMAIN_HINT);

    let whisperResponse;
    try {
      whisperResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...formData.getHeaders() },
        body: formData,
      });
    } catch (e) {
      try { fs.unlink(filepath, () => {}); } catch {}
      return res.status(502).json({ error: "Kunde inte nå Whisper API", details: String(e) });
    }

    const result = await whisperResponse.json().catch(()=>({}));
    try { fs.unlink(filepath, () => {}); } catch {}

    if (!whisperResponse.ok) {
      console.error("Whisper API error:", result);
      return res.status(500).json({ error: "Whisper API error", details: result });
    }

    // Trimma och säkra text
    const text = (result.text || "").toString().trim();

    return res.status(200).json({ text });
  } catch (error) {
    console.error("Whisper.js internal error:", error);
    return res.status(500).json({ error: "Serverfel i whisper.js", details: error.message || "Okänt fel" });
  }
}
