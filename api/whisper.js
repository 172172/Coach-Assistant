// /api/whisper.js

export const config = {
  api: {
    bodyParser: false, // Vi hanterar formdata manuellt
  },
};

import formidable from 'formidable';
import fs from 'fs';
import { promisify } from 'util';
import fetch from 'node-fetch';
import FormData from 'form-data';

const readFile = promisify(fs.readFile);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(500).json({ error: 'Form parsing failed' });
    }

    const file = files.audio;

    if (!file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    try {
      const audioData = await readFile(file.filepath);

      // Använd form-data istället för Blob (för Node.js)
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

      if (!whisperResponse.ok) {
        const errText = await whisperResponse.text();
        console.error("OpenAI Whisper Error:", errText);
        return res.status(500).json({ error: 'Whisper API error', details: errText });
      }

      const result = await whisperResponse.json();
      res.status(200).json({ text: result.text });
    } catch (error) {
      console.error("Whisper exception:", error);
      res.status(500).json({ error: 'Transcription failed', details: error.message });
    }
  });
}
