/**
 * Channel-agnostic voice transcription via whisper.cpp.
 *
 * Accepts a raw audio buffer (any format ffmpeg can read) and returns the
 * transcribed text, or null if transcription fails or yields empty output.
 *
 * Opt-in via `WHISPER_BIN`. When unset, callers must skip — this module never
 * runs whisper unprompted, because the binary may not be installed.
 *
 * Requirements:
 *   - `ffmpeg` on PATH (for the input → 16 kHz mono WAV conversion that
 *     whisper.cpp expects)
 *   - `whisper-cli` (or any whisper.cpp-compatible binary) at `WHISPER_BIN`
 *   - A whisper model file at `WHISPER_MODEL`
 *     (default: `data/models/ggml-base.bin` relative to cwd)
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { log } from './log.js';

const execFileAsync = promisify(execFile);

const FFMPEG_TIMEOUT_MS = 30_000;
const WHISPER_TIMEOUT_MS = 60_000;

function whisperBin(): string | null {
  return process.env.WHISPER_BIN || null;
}

function whisperModel(): string {
  return process.env.WHISPER_MODEL || path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');
}

/**
 * Transcribe a buffer of audio bytes. Returns null on any failure or if the
 * transcript is empty; callers should treat null as "no transcript available"
 * and not as an error to propagate.
 *
 * Writes the input to two temp files (the original bytes and a normalized
 * 16 kHz mono WAV) and cleans both up regardless of outcome.
 */
export async function transcribeAudioBuffer(audioBuffer: Buffer): Promise<string | null> {
  const bin = whisperBin();
  if (!bin) {
    log.debug('transcribeAudioBuffer skipped — WHISPER_BIN not set');
    return null;
  }

  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}-${process.pid}`;
  const tmpIn = path.join(tmpDir, `${id}.in`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpIn, audioBuffer);

    // whisper.cpp expects 16 kHz mono WAV. Run ffmpeg to normalize regardless
    // of the input container so we don't have to special-case ogg/mp3/m4a/etc.
    await execFileAsync('ffmpeg', ['-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav], {
      timeout: FFMPEG_TIMEOUT_MS,
    });

    const { stdout } = await execFileAsync(bin, ['-m', whisperModel(), '-f', tmpWav, '--no-timestamps', '-nt'], {
      timeout: WHISPER_TIMEOUT_MS,
    });

    const transcript = stdout.trim();
    return transcript || null;
  } catch (err) {
    log.warn('Voice transcription failed', { err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    for (const f of [tmpIn, tmpWav]) {
      try {
        fs.unlinkSync(f);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Heuristic: does this attachment look like audio worth transcribing?
 *
 * Checks `mimeType` first (set by most adapters), falls back to coarse
 * `type` (set by Telegram for stickers/voice/etc. where no MIME is supplied).
 */
export function isAudioAttachment(att: { mimeType?: string | null; type?: string | null } | undefined | null): boolean {
  if (!att) return false;
  if (att.mimeType && att.mimeType.startsWith('audio/')) return true;
  if (att.type === 'audio' || att.type === 'voice') return true;
  return false;
}
