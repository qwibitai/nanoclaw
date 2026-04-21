import { execFileSync } from 'child_process';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface TtsResult {
  audio: Buffer;
  cleanText: string;
}

interface TtsDirective {
  ttsText: string;
  cleanText: string;
}

const TTS_TAG_RE = /\[\[tts(?::([\s\S]*?))?\]\]|\[tts\]/i;

export function extractTtsDirective(text: string): TtsDirective | null {
  const match = text.match(TTS_TAG_RE);
  if (!match) return null;

  const cleanText = text.replace(TTS_TAG_RE, '').trim();
  const ttsText = match[1]?.trim() || cleanText;
  if (!ttsText) return null;

  return { ttsText, cleanText };
}

function getKeys(): { openai?: string; google?: string } {
  const env = readEnvFile(['OPENAI_TTS_API_KEY', 'GOOGLE_AI_API_KEY']);
  return {
    openai: process.env.OPENAI_TTS_API_KEY || env.OPENAI_TTS_API_KEY,
    google: process.env.GOOGLE_AI_API_KEY || env.GOOGLE_AI_API_KEY,
  };
}

async function synthesizeGemini(
  text: string,
  apiKey: string,
): Promise<Buffer> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        response_modalities: ['AUDIO'],
        speech_config: {
          voice_config: {
            prebuilt_voice_config: { voice_name: 'Sadaltager' },
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini TTS ${resp.status}: ${body.slice(0, 200)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const part = json.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error('Gemini TTS: no audio in response');
  }

  const pcmBuffer = Buffer.from(part.inlineData.data as string, 'base64');
  return pcmToOggOpus(pcmBuffer);
}

function pcmToOggOpus(pcm: Buffer): Buffer {
  return Buffer.from(
    execFileSync(
      'ffmpeg',
      [
        '-f',
        's16le',
        '-ar',
        '24000',
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-c:a',
        'libopus',
        '-b:a',
        '48k',
        '-f',
        'ogg',
        'pipe:1',
      ],
      { input: pcm, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
    ),
  );
}

async function synthesizeOpenAI(
  text: string,
  apiKey: string,
): Promise<Buffer> {
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: text,
      voice: 'ash',
      response_format: 'opus',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI TTS ${resp.status}: ${body.slice(0, 200)}`);
  }

  return Buffer.from(await resp.arrayBuffer());
}

export async function synthesize(text: string): Promise<Buffer | null> {
  const keys = getKeys();

  if (keys.google) {
    try {
      const audio = await synthesizeGemini(text, keys.google);
      logger.info({ provider: 'gemini', chars: text.length }, 'TTS synthesized');
      return audio;
    } catch (err) {
      logger.warn({ err }, 'Gemini TTS failed, trying OpenAI fallback');
    }
  }

  if (keys.openai) {
    try {
      const audio = await synthesizeOpenAI(text, keys.openai);
      logger.info({ provider: 'openai', chars: text.length }, 'TTS synthesized');
      return audio;
    } catch (err) {
      logger.error({ err }, 'OpenAI TTS failed');
    }
  }

  if (!keys.google && !keys.openai) {
    logger.warn('TTS: no API keys configured (GOOGLE_AI_API_KEY / OPENAI_TTS_API_KEY)');
  }

  return null;
}
