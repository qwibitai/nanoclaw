/**
 * Local audio transcription using whisper.cpp.
 * Channel-agnostic — channels download audio, then call transcribeAudio().
 * Runs on the host; agents receive plain text.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(os.homedir(), '.cache', 'whisper', 'ggml-small.bin');

/**
 * Check whether local transcription is available.
 * Returns false if whisper-cli or the model file is missing.
 */
export function isTranscriptionAvailable(): boolean {
  if (!fs.existsSync(WHISPER_MODEL)) {
    return false;
  }
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('which', [WHISPER_BIN], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Download a file from a URL to a temporary location.
 * Returns the local file path, or null on failure.
 */
export async function downloadToTemp(
  url: string,
  ext: string,
): Promise<string | null> {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-audio-'));
    const filePath = path.join(tmpDir, `audio${ext}`);
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    return filePath;
  } catch (err) {
    logger.error({ err }, 'Failed to download audio file');
    return null;
  }
}

/**
 * Transcribe a local audio file using whisper.cpp.
 * Converts to 16kHz mono WAV via ffmpeg, then runs whisper-cli.
 * Returns transcript text or null on failure. Cleans up intermediate files.
 */
export async function transcribeAudio(
  filePath: string,
): Promise<string | null> {
  const wavPath = filePath.replace(/\.[^.]+$/, '') + '.wav';
  try {
    // Convert to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync('ffmpeg', [
      '-i',
      filePath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      '-y',
      wavPath,
    ]);

    // Run whisper-cli
    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', wavPath, '--no-timestamps', '-l', 'auto'],
      { timeout: 600_000 },
    );

    const text = stdout.trim();
    if (!text) return null;

    logger.info({ chars: text.length }, 'Transcription complete');
    return text;
  } catch (err) {
    logger.error({ err, filePath }, 'Transcription failed');
    return null;
  } finally {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* already cleaned up or never created */
    }
  }
}
