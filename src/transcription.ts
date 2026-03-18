import OpenAI, { toFile } from 'openai';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

let cachedClient: OpenAI | null | undefined; // undefined = not checked yet

function getClient(): OpenAI | null {
  if (cachedClient !== undefined) return cachedClient;
  const secrets = readEnvFile(['OPENAI_API_KEY']);
  if (!secrets.OPENAI_API_KEY) {
    cachedClient = null;
    logger.info('Voice transcription disabled (OPENAI_API_KEY not set)');
    return null;
  }
  cachedClient = new OpenAI({ apiKey: secrets.OPENAI_API_KEY });
  return cachedClient;
}

/**
 * Whether transcription is available (OpenAI API key configured).
 */
export function isTranscriptionAvailable(): boolean {
  return getClient() !== null;
}

/**
 * Transcribe an audio buffer using OpenAI Whisper.
 * Returns the transcribed text, or null on failure (graceful fallback).
 * Supports OGG, OPUS, MP3, WAV, M4A natively.
 */
export async function transcribeAudio(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const file = await toFile(buffer, filename);
    const response = await client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
    });
    return response.text || null;
  } catch (err) {
    logger.warn({ err, filename }, 'Voice transcription failed');
    return null;
  }
}
