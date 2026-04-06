import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

/**
 * Transcribe an audio buffer using a local whisper.cpp binary.
 *
 * Writes the buffer to a temp file, converts to 16kHz mono WAV via ffmpeg,
 * then runs whisper-cli. Returns the transcript string, or null on failure.
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const ext = path.extname(filename) || '.ogg';
  const tmpIn = path.join(tmpDir, `${id}${ext}`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpIn, buffer);

    // Convert to 16kHz mono WAV — required by whisper.cpp
    await execFileAsync(
      'ffmpeg',
      ['-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', tmpWav, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );

    const transcript = stdout.trim();
    if (!transcript) return null;

    logger.info(
      { bin: WHISPER_BIN, model: WHISPER_MODEL, chars: transcript.length },
      'whisper.cpp transcription complete',
    );
    return transcript;
  } catch (err) {
    logger.error({ err }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    for (const f of [tmpIn, tmpWav]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
