import fs from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

const WHISPER_MODEL = 'whisper-1';
const FALLBACK = '[Voice Message - transcription unavailable]';

export async function transcribeAudioFile(relativeOrAbsolutePath: string): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn('OPENAI_API_KEY not set in .env — skipping transcription');
    return null;
  }

  const filePath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(DATA_DIR, relativeOrAbsolutePath);

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (err) {
    log.warn('transcription: failed to read audio file', {
      filePath,
      err: String(err),
    });
    return null;
  }
  if (buffer.length === 0) return null;

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;
    const openai = new OpenAI({ apiKey });

    const ext = path.extname(filePath).toLowerCase() || '.ogg';
    const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/m4a' : 'audio/ogg';

    const file = await toFile(buffer, `voice${ext}`, { type: mime });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: WHISPER_MODEL,
      response_format: 'text',
    });

    const text = (transcription as unknown as string).trim();
    return text || null;
  } catch (err) {
    log.warn('transcription: OpenAI Whisper call failed', { err: String(err) });
    return null;
  }
}

export const TRANSCRIPTION_FALLBACK = FALLBACK;
