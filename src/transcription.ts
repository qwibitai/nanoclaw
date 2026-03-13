import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  downloadMediaMessage,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

const FALLBACK_MESSAGE = '[Voice Message - transcription unavailable]';

/**
 * Transcribe a local audio file using whisper.cpp.
 * Converts the file to 16kHz mono WAV via ffmpeg, then runs whisper-cli.
 * Returns the transcript text, or null if transcription fails or produces no output.
 */
export async function transcribeAudioFile(
  filePath: string,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    // Convert input audio to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync(
      'ffmpeg',
      ['-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
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
    console.error('whisper.cpp transcription failed:', err);
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpWav);
    } catch {
      /* best effort cleanup */
    }
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
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
      console.error('Failed to download audio message');
      return FALLBACK_MESSAGE;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    // Write buffer to a temp .ogg file, then use the generic transcriber
    const tmpOgg = path.join(
      os.tmpdir(),
      `nanoclaw-wa-${Date.now()}.ogg`,
    );
    let transcript: string | null;
    try {
      fs.writeFileSync(tmpOgg, buffer);
      transcript = await transcribeAudioFile(tmpOgg);
    } finally {
      try {
        fs.unlinkSync(tmpOgg);
      } catch {
        /* best effort cleanup */
      }
    }

    if (!transcript) {
      return FALLBACK_MESSAGE;
    }

    console.log(`Transcribed voice message: ${transcript.length} chars`);
    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return FALLBACK_MESSAGE;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
