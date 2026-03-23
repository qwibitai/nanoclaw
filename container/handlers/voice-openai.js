/**
 * Voice/audio transcription handler — OpenAI Whisper API.
 * Priority 50 (fallback after local whisper). Falls through if no API key.
 */
import fs from 'fs';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function handler(filePath) {
  if (!OPENAI_API_KEY) return null;
  if (!fs.existsSync(filePath)) return null;

  try {
    const buffer = fs.readFileSync(filePath);
    const blob = new Blob([buffer], { type: 'audio/ogg' });
    const form = new FormData();
    form.append('file', blob, 'voice.ogg');
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!res.ok) return null;
    const text = (await res.text()).trim();
    if (!text) return null;

    return [{ type: 'text', text: `[Voice transcript]: ${text}` }];
  } catch {
    return null;
  }
}

export default [
  { type: 'voice', priority: 50, handler },
  { type: 'audio', priority: 50, handler },
];
