import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

interface TranscriptionConfig {
  whisperBin: string;
  modelPath: string;
  enabled: boolean;
  fallbackMessage: string;
  language: string;
}

function getConfig(): TranscriptionConfig {
  const env = readEnvFile([
    'WHISPER_CPP_PATH',
    'WHISPER_MODEL_PATH',
    'WHISPER_LANGUAGE',
  ]);
  return {
    whisperBin: env.WHISPER_CPP_PATH || 'whisper-cpp',
    modelPath:
      env.WHISPER_MODEL_PATH || '/usr/local/share/whisper/ggml-tiny.bin',
    enabled: true,
    fallbackMessage: '[Voice Message - transcription unavailable]',
    language: env.WHISPER_LANGUAGE || 'en',
  };
}

/**
 * Convert OGG/Opus audio (WhatsApp format) to 16kHz mono WAV (whisper.cpp format)
 * using ffmpeg.
 */
async function convertToWav(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-i',
      inputPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      '-y',
      outputPath,
    ],
    { timeout: 30000 },
  );
}

/**
 * Transcribe a WAV file using whisper.cpp.
 * Returns the transcribed text or null on failure.
 */
async function transcribeWithWhisperCpp(
  wavPath: string,
  config: TranscriptionConfig,
): Promise<string | null> {
  // Verify model exists
  if (!fs.existsSync(config.modelPath)) {
    logger.error(
      { modelPath: config.modelPath },
      'Whisper model file not found',
    );
    return null;
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      config.whisperBin,
      [
        '-m',
        config.modelPath,
        '-f',
        wavPath,
        '--no-timestamps',
        '-l',
        config.language,
        '--output-txt',
        '-of',
        wavPath.replace('.wav', ''),
      ],
      { timeout: 120000 },
    ); // 2 minute timeout for long voice notes

    // whisper.cpp writes output to <input>.txt
    const txtPath = wavPath.replace('.wav', '.txt');
    if (fs.existsSync(txtPath)) {
      const text = fs.readFileSync(txtPath, 'utf-8').trim();
      // Clean up the txt file
      fs.unlinkSync(txtPath);
      return text || null;
    }

    // Fallback: try to parse stdout (some versions output to stdout)
    if (stdout) {
      const lines = stdout
        .split('\n')
        .filter((l: string) => l.trim() && !l.startsWith('['));
      const text = lines.join(' ').trim();
      if (text) return text;
    }

    logger.warn(
      { stderr: stderr?.slice(0, 200) },
      'whisper.cpp produced no output',
    );
    return null;
  } catch (err) {
    logger.error({ err }, 'whisper.cpp transcription failed');
    return null;
  }
}

/**
 * Transcribe an audio buffer (OGG/Opus or any ffmpeg-supported format).
 * Channel-agnostic — works for WhatsApp, Telegram, or any source.
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
): Promise<string | null> {
  const config = getConfig();

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  const tmpDir = os.tmpdir();
  const timestamp = Date.now();
  const oggPath = path.join(tmpDir, `nanoclaw-voice-${timestamp}.ogg`);
  const wavPath = path.join(tmpDir, `nanoclaw-voice-${timestamp}.wav`);

  try {
    if (!buffer || buffer.length === 0) {
      logger.error('Empty audio buffer');
      return config.fallbackMessage;
    }

    logger.info({ bytes: buffer.length }, 'Downloaded audio message');

    // Write audio to temp file
    fs.writeFileSync(oggPath, buffer);

    // Convert to WAV
    await convertToWav(oggPath, wavPath);
    logger.debug({ wavPath }, 'Converted audio to WAV');

    // Transcribe with whisper.cpp
    const transcript = await transcribeWithWhisperCpp(wavPath, config);

    if (!transcript) {
      return config.fallbackMessage;
    }

    logger.info({ length: transcript.length }, 'Transcribed voice message');
    return transcript.trim();
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  } finally {
    // Clean up temp files
    try {
      fs.unlinkSync(oggPath);
    } catch {}
    try {
      fs.unlinkSync(wavPath);
    } catch {}
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const buffer = (await downloadMediaMessage(
    msg,
    'buffer',
    {},
    {
      logger: console as any,
      reuploadRequest: sock.updateMediaMessage,
    },
  )) as Buffer;

  return transcribeAudioBuffer(buffer);
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}

// =========================================================
// Image handling — download WhatsApp images for agent access
// =========================================================

/**
 * Check if a WAMessage contains an image.
 */
export function isImageMessage(msg: WAMessage): boolean {
  const normalized = msg.message;
  if (!normalized) return false;

  // Check all possible container types for imageMessage
  return !!(
    normalized.imageMessage ||
    normalized.viewOnceMessage?.message?.imageMessage ||
    normalized.viewOnceMessageV2?.message?.imageMessage ||
    normalized.ephemeralMessage?.message?.imageMessage
  );
}

/**
 * Download a WhatsApp image message and save it to the group's IPC input directory.
 * Returns the container-side file path (e.g. /workspace/ipc/input/img-1709654321000.jpg)
 * or null if download fails.
 *
 * Images are saved to data/ipc/{groupFolder}/input/ on the host,
 * which is mounted at /workspace/ipc/input/ inside the container.
 *
 * Old images (>1 hour) are cleaned up automatically.
 */
export async function downloadImageToFile(
  msg: WAMessage,
  sock: WASocket,
  groupFolder: string,
): Promise<string | null> {
  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Empty image buffer');
      return null;
    }

    // Determine file extension from mimetype
    const imgMsg =
      msg.message?.imageMessage ||
      msg.message?.viewOnceMessage?.message?.imageMessage ||
      msg.message?.viewOnceMessageV2?.message?.imageMessage ||
      msg.message?.ephemeralMessage?.message?.imageMessage;

    const mimetype = imgMsg?.mimetype || 'image/jpeg';
    const ext = mimetype.includes('png')
      ? 'png'
      : mimetype.includes('webp')
        ? 'webp'
        : mimetype.includes('gif')
          ? 'gif'
          : 'jpg';

    // Save to group's IPC input directory (mounted at /workspace/ipc/input/ in container)
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    fs.mkdirSync(inputDir, { recursive: true });

    const timestamp = Date.now();
    const filename = `img-${timestamp}.${ext}`;
    const hostPath = path.join(inputDir, filename);

    fs.writeFileSync(hostPath, buffer);
    logger.info(
      { bytes: buffer.length, path: hostPath, mimetype },
      'Saved WhatsApp image for agent access',
    );

    // Clean up old images (older than 1 hour)
    cleanupOldMedia(inputDir, 60 * 60 * 1000);

    // Return container-side path
    return `/workspace/ipc/input/${filename}`;
  } catch (err) {
    logger.error({ err }, 'Failed to download WhatsApp image');
    return null;
  }
}

/**
 * Remove media files older than maxAge from a directory.
 */
function cleanupOldMedia(dir: string, maxAgeMs: number): void {
  try {
    const files = fs.readdirSync(dir);
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith('img-')) continue;
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          logger.debug({ file }, 'Cleaned up old media file');
        }
      } catch {}
    }
  } catch {}
}
