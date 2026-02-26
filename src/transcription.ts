import { downloadMediaMessage, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Lazy-loaded transcription pipeline (model downloaded on first use, ~150MB)
let transcriber: ((input: Float32Array) => Promise<{ text: string }>) | null = null;

async function getTranscriber() {
  if (!transcriber) {
    logger.info('Loading Whisper model (first run will download ~150MB)...');
    const { pipeline } = await import('@xenova/transformers');
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny') as any;
    logger.info('Whisper model ready');
  }
  return transcriber!;
}

async function getFfmpegPath(): Promise<string> {
  const ffmpegStatic = await import('ffmpeg-static');
  const bin = (ffmpegStatic.default ?? ffmpegStatic) as unknown as string;
  if (!bin) throw new Error('ffmpeg-static binary not found');
  return bin;
}

async function convertOggToWav(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = await getFfmpegPath();
  await execFileAsync(ffmpeg, [
    '-y',
    '-i', inputPath,
    '-ar', '16000',
    '-ac', '1',
    '-f', 'wav',
    outputPath,
  ]);
}

async function wavToFloat32(wavPath: string): Promise<Float32Array> {
  const wavefileModule = await import('wavefile');
  const WaveFile = wavefileModule.WaveFile ?? (wavefileModule as any).default?.WaveFile ?? (wavefileModule as any).default;
  const buf = fs.readFileSync(wavPath);
  const wav = new WaveFile(buf);
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);
  const samples = wav.getSamples();
  // getSamples returns Float64Array for mono, or [Float64Array, ...] for multi-channel
  const channel = Array.isArray(samples) ? samples[0] : samples;
  return new Float32Array(channel as ArrayLike<number>);
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const id = `nanoclaw-voice-${Date.now()}`;
  const oggPath = path.join(os.tmpdir(), `${id}.ogg`);
  const wavPath = path.join(os.tmpdir(), `${id}.wav`);

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
      logger.error('Failed to download audio message');
      return null;
    }

    logger.info({ bytes: buffer.length }, 'Downloaded voice message, transcribing...');

    fs.writeFileSync(oggPath, buffer);
    await convertOggToWav(oggPath, wavPath);

    const audioData = await wavToFloat32(wavPath);
    const pipe = await getTranscriber();
    const result = await pipe(audioData);
    const text = result?.text?.trim();

    if (!text) return null;

    logger.info({ length: text.length }, 'Voice message transcribed');
    return text;
  } catch (err) {
    logger.error({ err }, 'Transcription failed');
    return null;
  } finally {
    for (const p of [oggPath, wavPath]) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
