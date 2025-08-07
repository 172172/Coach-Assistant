import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';

// Ingen promisify behövs längre, vi använder fs.promises direkt

function parseForm(req) {
  const form = new IncomingForm({
    keepExtensions: true,
    multiples: false,
    maxFileSize: 100 * 1024 * 1024, // 100 MB
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const { files } = await parseForm(req);
    console.log('Files object:', files); // Debug

    const file = files.audio;

    if (!file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    // Debug loggar
    console.log('File object:', file);
    console.log('file.filepath:', file.filepath);
    console.log('file.path:', file.path);

    // Försök läsa från filepath eller path
    const filePath = file.filepath ?? file.path;
    if (!filePath) {
      throw new Error('No valid file path found');
    }

    const audioData = await fs.promises.readFile(filePath);

    const formData = new FormData();
    formData.append('file', audioData, {
      filename: 'audio.webm',
      contentType: 'audio/webm',
    });
    formData.append('model', 'whisper-1');
    formData.append('language', 'sv');

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    const result = await whisperResponse.json();

    if (!whisperResponse.ok) {
      console.error("Whisper API error:", result);
      return res.status(500).json({ error: 'Whisper API error', details: result });
    }

    res.status(200).json({ text: result.text });
  } catch (error) {
    console.error("Whisper.js internal error:", error);
    return res.status(500).json({
      error: 'Serverfel i whisper.js',
      details: error.message || 'Okänt fel'
    });
  }
}
