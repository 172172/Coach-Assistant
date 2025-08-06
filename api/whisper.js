import { IncomingForm } from 'formidable';
import fs from 'fs';
import { promisify } from 'util';
import fetch from 'node-fetch';
import FormData from 'form-data';

const readFile = promisify(fs.readFile);

function parseForm(req) {
  const form = new IncomingForm();
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
    const file = files.audio;

    if (!file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const audioData = await readFile(file.filepath);

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
