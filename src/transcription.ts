import { execFile, exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import type { WAMessage } from '@whiskeysockets/baileys';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const envConfig = readEnvFile([
  'WHISPER_URL',
  'WHISPER_LANG',
  'WHISPER_BIN',
  'WHISPER_MODEL',
]);

// HTTP server mode (preferred when WHISPER_URL is set)
const WHISPER_URL = envConfig.WHISPER_URL || process.env.WHISPER_URL;
const WHISPER_LANG = envConfig.WHISPER_LANG || process.env.WHISPER_LANG || 'de';

// whisper-cli mode (fallback when no WHISPER_URL)
const WHISPER_BIN =
  envConfig.WHISPER_BIN || process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  envConfig.WHISPER_MODEL ||
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

const FALLBACK_MESSAGE = '[Voice Message - transcription unavailable]';

/**
 * Check whether a WAMessage is a voice message (push-to-talk audio).
 */
export function isVoiceMessage(msg: WAMessage): boolean {
  return (msg.message?.audioMessage as Record<string, unknown>)?.ptt === true;
}

/**
 * Download and transcribe a voice/audio message.
 * Uses HTTP server if WHISPER_URL is set, otherwise falls back to whisper-cli.
 */
export async function transcribeAudioMessage(
  msg: WAMessage,
): Promise<string | null> {
  try {
    const audioBuffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
    )) as Buffer;

    if (!audioBuffer || audioBuffer.length === 0) {
      logger.error('Failed to download audio message');
      return FALLBACK_MESSAGE;
    }

    const mimeType =
      msg.message?.audioMessage?.mimetype || 'audio/ogg; codecs=opus';

    logger.info({ bytes: audioBuffer.length }, 'Downloaded audio message');

    const transcript = WHISPER_URL
      ? await transcribeWithHttpServer(audioBuffer, mimeType)
      : await transcribeWithWhisperCpp(audioBuffer);

    if (!transcript) {
      return FALLBACK_MESSAGE;
    }

    logger.info({ length: transcript.length }, 'Transcribed voice message');
    return transcript.trim();
  } catch (err) {
    logger.warn({ err }, 'Failed to download/transcribe audio message');
    return FALLBACK_MESSAGE;
  }
}

/**
 * Transcribe via HTTP Whisper server (e.g. faster-whisper-server, distil-whisper).
 * Saves audio to temp file, POSTs via curl, parses JSON response.
 */
async function transcribeWithHttpServer(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const ext = mimeType.includes('ogg') ? 'ogg' : 'mp4';
  const tmpFile = path.join(os.tmpdir(), `nanoclaw-stt-${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(tmpFile, audioBuffer);
    const response = await new Promise<string>((resolve, reject) => {
      exec(
        `curl -s -X POST "${WHISPER_URL}/transcribe" -F "file=@${tmpFile}" -F "language=${WHISPER_LANG}" --max-time 30`,
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
    const data = JSON.parse(response) as { text?: string; detail?: string };
    if (data.detail) {
      logger.warn({ detail: data.detail }, 'Whisper server returned error');
      return null;
    }
    if (!data.text) {
      logger.warn(
        { response: response.slice(0, 200) },
        'Whisper server returned no text',
      );
      return null;
    }
    return data.text.trim() || null;
  } catch (err) {
    logger.warn({ err }, 'Whisper HTTP server STT error');
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Transcribe via local whisper-cli binary (whisper.cpp).
 * Converts audio to 16kHz mono WAV via ffmpeg, then runs whisper-cli.
 */
async function transcribeWithWhisperCpp(
  audioBuffer: Buffer,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-stt-${Date.now()}`;
  const tmpOgg = path.join(tmpDir, `${id}.ogg`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpOgg, audioBuffer);

    // Convert ogg/opus to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync(
      'ffmpeg',
      ['-i', tmpOgg, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', tmpWav, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );

    const transcript = stdout.trim();
    return transcript || null;
  } catch (err) {
    logger.warn({ err }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    for (const f of [tmpOgg, tmpWav]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort cleanup */
      }
    }
  }
}
