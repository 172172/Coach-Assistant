// /api/whisper.js
export const config = {
  api: { bodyParser: false },
};

import formidable from "formidable";
import fs from "fs";
import { promisify } from "util";
import fetch from "node-fetch";
import FormData from "form-data";

const readFile = promisify(fs.readFile);

// Formidable v3: använd funktionen formidable({...})
function parseForm(req) {
  const form = formidable({
    multiples: false,
    keepExtensions: true,
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const { files } = await parseForm(req);

    // files.audio kan vara array i v3
    const uploaded = files.audio;
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;

    if (!file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    // I v3 ligger sökvägen i file.filepath (fallback till _writeStream.path)
    const filepath = file.filepath || file._writeStream?.path;
    if (!filepath) {
      return res.status(500).json({
        error: "Serverfel i whisper.js",
        details: "No valid file path found",
      });
    }

    const audioData = await readFile(filepath);

    // Skicka till OpenAI Whisper
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
    // Hjälper Whisper med domänord → färre konstiga feltolkningar
    formData.append(
      "prompt",
      "Carlsberg, Linje 65, tapp, pastör, depalletizer, Kisters, OCME, Jones, gejdrar, givare, fals, Coolpack, 6-pack, 20-pack, 24-pack, CIP"
    );

    const whisperResponse = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    const result = await whisperResponse.json();

    // Städa tempfil oavsett
    try { fs.unlink(filepath, () => {}); } catch {}

    if (!whisperResponse.ok) {
      console.error("Whisper API error:", result);
      return res.status(500).json({ error: "Whisper API error", details: result });
    }

    return res.status(200).json({ text: (result.text || "").trim() });
  } catch (error) {
    console.error("Whisper.js internal error:", error);
    return res.status(500).json({
      error: "Serverfel i whisper.js",
      details: error.message || "Okänt fel",
    });
  }
}
