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

function parseForm(req) {
  const form = new formidable.IncomingForm();
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const { files } = await parseForm(req);

    // files.audio kan vara en array (vanligt i formidable v3)
    const uploaded = files.audio;
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;

    if (!file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    // Hämta faktisk filväg (formidable kan lägga den i filepath, fallback till _writeStream.path)
    const filepath = file.filepath || file._writeStream?.path;
    if (!filepath) {
      return res.status(500).json({ error: "Serverfel i whisper.js", details: "No valid file path found" });
    }

    const audioData = await readFile(filepath);

    // Bygg multipart/form-data för OpenAI Whisper
    const formData = new FormData();
    formData.append("file", audioData, {
      filename: "audio.webm",
      contentType: file.mimetype || "audio/webm",
    });
    formData.append("model", "whisper-1");
    formData.append("language", "sv");

    const whisperResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    // Läs alltid JSON så frontend kan .json() utan krasch
    const result = await whisperResponse.json();

    if (!whisperResponse.ok) {
      console.error("Whisper API error:", result);
      return res.status(500).json({ error: "Whisper API error", details: result });
    }

    return res.status(200).json({ text: result.text });
  } catch (error) {
    console.error("Whisper.js internal error:", error);
    return res.status(500).json({
      error: "Serverfel i whisper.js",
      details: error.message || "Okänt fel",
    });
  }
}
