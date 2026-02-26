import fs from 'fs';
import os from 'os';
import path from 'path';

import Groq from 'groq-sdk';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const { GROQ_API_KEY } = readEnvFile(['GROQ_API_KEY']);

export async function transcribeAudioBuffer(buffer: Buffer, ext = 'ogg'): Promise<string> {
  if (!GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set, cannot transcribe voice message');
    return '[Voice Message - transcription unavailable]';
  }

  const tmpFile = path.join(os.tmpdir(), `nanoclaw-voice-${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(tmpFile, buffer);

    const groq = new Groq({ apiKey: GROQ_API_KEY });
    const result = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-large-v3-turbo',
    });

    const transcript = result.text?.trim();
    if (!transcript) return '[Voice Message - empty transcript]';

    logger.info({ chars: transcript.length }, 'Transcribed voice message');
    return `[Voice: ${transcript}]`;
  } catch (err) {
    logger.error({ err }, 'Groq transcription failed');
    return '[Voice Message - transcription failed]';
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}
