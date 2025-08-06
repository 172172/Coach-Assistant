// /api/whisper.js

export const config = {
  api: {
    bodyParser: false, // vi behöver hantera rå ljuddata
  },
};

import formidable from 'formidable';
import fs from 'fs';
import { promisify } from 'util';
import fetch from 'node-fetch';

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

      const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: (() => {
          const formData = new FormData();
          formData.append('file', new Blob([audioData]), 'audio.webm');
          formData.append('model', 'whisper-1');
          formData.append('language', 'sv');
          return formData;
        })(),
      });

      const result = await whisperResponse.json();

      if (result.error) {
        return res.status(500).json({ error: result.error.message });
      }

      res.status(200).json({ text: result.text });
    } catch (error) {
      res.status(500).json({ error: 'Transcription failed', details: error.message });
    }
  });
}
