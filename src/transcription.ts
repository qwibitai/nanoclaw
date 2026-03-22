import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';

const execFileAsync = promisify(execFile);

// Read transcription config from .env (NanoClaw doesn't use dotenv)
const envConfig = readEnvFile([
  'TRANSCRIPTION_BACKEND',
  'WHISPER_BIN',
  'WHISPER_MODEL',
  'OPENAI_API_KEY',
]);

// Transcription backend: 'local' uses whisper.cpp, 'api' uses OpenAI Whisper API
const TRANSCRIPTION_BACKEND =
  process.env.TRANSCRIPTION_BACKEND || envConfig.TRANSCRIPTION_BACKEND || 'local';

// Local whisper.cpp settings
const WHISPER_BIN = process.env.WHISPER_BIN || envConfig.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  envConfig.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

// OpenAI API settings
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || envConfig.OPENAI_API_KEY || '';
const OPENAI_WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

async function transcribeLocal(audioBuffer: Buffer): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const tmpOgg = path.join(tmpDir, `${id}.ogg`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpOgg, audioBuffer);

    // Convert ogg/opus to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync('ffmpeg', [
      '-i', tmpOgg,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y', tmpWav,
    ], { timeout: 30_000 });

    const { stdout } = await execFileAsync(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', tmpWav,
      '--no-timestamps',
      '-nt',
    ], { timeout: 60_000 });

    const transcript = stdout.trim();
    return transcript || null;
  } catch (err) {
    console.error('whisper.cpp transcription failed:', err);
    return null;
  } finally {
    for (const f of [tmpOgg, tmpWav]) {
      try { fs.unlinkSync(f); } catch { /* best effort cleanup */ }
    }
  }
}

async function transcribeApi(audioBuffer: Buffer): Promise<string | null> {
  try {
    const boundary = `----nanoclaw${Date.now()}`;
    const filename = `voice-${Date.now()}.ogg`;

    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: audio/ogg\r\n\r\n`,
    );
    const modelPart = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1` +
      `\r\n--${boundary}--\r\n`,
    );
    const body = Buffer.concat([preamble, audioBuffer, modelPart]);

    const res = await fetch(OPENAI_WHISPER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      console.error(`OpenAI Whisper API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    console.error('OpenAI Whisper API transcription failed:', err);
    return null;
  }
}

/**
 * Transcribe an audio buffer to text.
 * Uses local whisper.cpp or OpenAI Whisper API based on TRANSCRIPTION_BACKEND env var.
 * Channel-agnostic — any channel can call this with a raw audio buffer.
 */
export async function transcribe(audioBuffer: Buffer): Promise<string | null> {
  if (TRANSCRIPTION_BACKEND === 'api') {
    if (!OPENAI_API_KEY) {
      console.error('OPENAI_API_KEY not set — cannot use API transcription backend');
      return null;
    }
    return transcribeApi(audioBuffer);
  }
  return transcribeLocal(audioBuffer);
}
