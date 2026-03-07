import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

import { WHISPER_BIN, WHISPER_MODEL } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

function getOpenAIKey(): string {
  const env = readEnvFile(['OPENAI_API_KEY']);
  return process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '';
}

/**
 * Convert AAC (raw ADTS, unsupported by Whisper) to 16kHz mono WAV.
 * Returns the WAV path and a cleanup function.
 */
async function toWav(filePath: string): Promise<{ wavPath: string; cleanup: () => void }> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wav') {
    return { wavPath: filePath, cleanup: () => {} };
  }
  const tmpWav = path.join(os.tmpdir(), `nanoclaw-${Date.now()}.wav`);
  await execFileAsync('ffmpeg', ['-i', filePath, '-ar', '16000', '-ac', '1', tmpWav, '-y']);
  return { wavPath: tmpWav, cleanup: () => fs.unlink(tmpWav, () => {}) };
}

async function transcribeLocal(wavPath: string): Promise<string> {
  const outputTxt = wavPath + '.txt';
  try {
    await execFileAsync(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '--output-txt',
      '--no-prints',
      '-nt',   // no timestamps in output
    ]);
    const text = fs.readFileSync(outputTxt, 'utf8').trim();
    return text;
  } finally {
    fs.unlink(outputTxt, () => {});
  }
}

async function transcribeOpenAI(wavPath: string): Promise<string> {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  const openai = new OpenAI({ apiKey });
  const file = await toFile(fs.createReadStream(wavPath), path.basename(wavPath));
  const result = await openai.audio.transcriptions.create({ file, model: 'whisper-1' });
  return result.text;
}

export async function transcribeAudio(filePath: string): Promise<string> {
  logger.debug({ filePath }, 'Transcribing audio');

  const { wavPath, cleanup } = await toWav(filePath);
  try {
    // Try local whisper-cli first
    if (WHISPER_BIN) {
      try {
        const text = await transcribeLocal(wavPath);
        logger.debug({ filePath }, 'Transcribed locally');
        return text;
      } catch (localErr) {
        logger.warn(
          { err: localErr, WHISPER_BIN, WHISPER_MODEL },
          'Local whisper failed, falling back to OpenAI',
        );
      }
    }

    // Fallback: OpenAI Whisper API
    return await transcribeOpenAI(wavPath);
  } finally {
    cleanup();
  }
}
