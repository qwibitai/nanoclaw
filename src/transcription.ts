/**
 * Voice message transcription via Groq Whisper API.
 * Downloads are handled by telegram-media.ts; this module
 * takes a local audio file path and returns the transcript.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const GROQ_TRANSCRIPTION_URL =
  'https://api.groq.com/openai/v1/audio/transcriptions';

const AUDIO_MIME: Record<string, string> = {
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

/**
 * Transcribe an audio file using Groq's Whisper API.
 * Returns the transcript text, or empty string on failure.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const env = readEnvFile(['GROQ_API_KEY', 'WHISPER_MODEL']);
  if (!env.GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set, skipping voice transcription');
    return '';
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = AUDIO_MIME[ext] || 'audio/ogg';
  const buffer = fs.readFileSync(filePath);

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), `audio${ext}`);
  form.append('model', env.WHISPER_MODEL || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');

  try {
    const res = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, 'Groq transcription failed');
      return '';
    }

    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || '';
  } catch (err) {
    logger.error({ err, filePath }, 'Voice transcription error');
    return '';
  }
}
