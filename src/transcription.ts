import OpenAI from 'openai';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile(['OPENAI_API_KEY', 'TRANSCRIPTION_MODEL']);

const OPENAI_API_KEY = env.OPENAI_API_KEY;
const TRANSCRIPTION_MODEL = env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';

let client: OpenAI | null = null;

let warnedMissingKey = false;

function getClient(): OpenAI | null {
  if (!OPENAI_API_KEY) {
    if (!warnedMissingKey) {
      logger.warn('OPENAI_API_KEY not set — audio transcription disabled');
      warnedMissingKey = true;
    }
    return null;
  }
  if (!client) {
    client = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return client;
}

/**
 * Transcribe an audio buffer using OpenAI's transcription API.
 * Returns the transcript text, or null if transcription fails or is empty.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
): Promise<string | null> {
  const openai = getClient();
  if (!openai) return null;

  try {
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      m4a: 'audio/mp4',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      opus: 'audio/opus',
      wav: 'audio/wav',
      webm: 'audio/webm',
    };
    const mimeType = mimeTypes[ext || ''] || 'audio/mp4';
    const file = new File([audioBuffer], filename, { type: mimeType });

    const response = await openai.audio.transcriptions.create({
      model: TRANSCRIPTION_MODEL,
      file,
    });

    const text = response.text?.trim();
    if (!text) {
      logger.info({ filename }, 'Transcription returned empty text');
      return null;
    }

    logger.info(
      { filename, length: text.length },
      'Audio transcribed successfully',
    );
    return text;
  } catch (err) {
    logger.error({ err, filename }, 'Audio transcription failed');
    return null;
  }
}

/** Whether transcription is available (API key is set). */
export function isTranscriptionAvailable(): boolean {
  return !!OPENAI_API_KEY;
}
