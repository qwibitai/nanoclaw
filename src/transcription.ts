import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { WHISPER_BIN, WHISPER_MODEL } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * Transcribe an audio file using local whisper.cpp.
 * Returns the transcript text, or null if transcription is unavailable/fails.
 * The input file can be any format ffmpeg supports (OGG, MP3, M4A, etc.).
 */
export async function transcribeAudio(
  inputPath: string,
): Promise<string | null> {
  const modelPath = path.resolve(WHISPER_MODEL);
  if (!fs.existsSync(modelPath)) {
    logger.warn(
      { modelPath },
      'Whisper model not found, skipping transcription',
    );
    return null;
  }

  const wavPath = path.join(
    os.tmpdir(),
    `nanoclaw-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  );

  try {
    // Convert to 16kHz mono WAV (whisper.cpp requirement)
    // Use full path — launchd PATH doesn't include /opt/homebrew/bin
    const ffmpegBin = fs.existsSync('/opt/homebrew/bin/ffmpeg')
      ? '/opt/homebrew/bin/ffmpeg'
      : 'ffmpeg';
    await execFileAsync(
      ffmpegBin,
      ['-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath],
      { timeout: 30_000 },
    );

    // Run whisper.cpp
    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', modelPath, '-f', wavPath, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );

    const transcript = stdout.trim();
    if (!transcript) {
      logger.warn('Whisper produced empty transcript');
      return null;
    }

    logger.info({ chars: transcript.length }, 'Transcribed voice message');
    return transcript;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      logger.warn(
        { bin: err.path },
        'Transcription binary not found, skipping',
      );
    } else {
      logger.warn({ err: err.message }, 'whisper.cpp transcription failed');
    }
    return null;
  } finally {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* ignore */
    }
  }
}
