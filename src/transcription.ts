import { log } from './log.js';
import { readEnvFile } from './env.js';

interface AsrConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
  prompt?: string;
}

let cachedConfig: AsrConfig | null | undefined = undefined;

function loadConfig(): AsrConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const env = readEnvFile(['ASR_BASE_URL', 'ASR_API_KEY', 'ASR_MODEL', 'ASR_LANGUAGE', 'ASR_PROMPT']);
  const baseUrl = process.env.ASR_BASE_URL || env.ASR_BASE_URL;
  const apiKey = process.env.ASR_API_KEY || env.ASR_API_KEY;

  if (!baseUrl || !apiKey) {
    cachedConfig = null;
    return null;
  }

  cachedConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: process.env.ASR_MODEL || env.ASR_MODEL || 'whisper-1',
    language: process.env.ASR_LANGUAGE || env.ASR_LANGUAGE || undefined,
    prompt: process.env.ASR_PROMPT || env.ASR_PROMPT || undefined,
  };
  return cachedConfig;
}

export function isTranscriptionEnabled(): boolean {
  return loadConfig() !== null;
}

/**
 * Transcribe an in-memory audio buffer via an OpenAI-compatible
 * /audio/transcriptions endpoint. Returns transcript text, or null if
 * transcription is disabled or fails.
 *
 * v2 chat-sdk-bridge already holds the audio buffer from att.fetchData() —
 * no disk round-trip needed. Bearer auth via ASR_API_KEY, endpoint via
 * ASR_BASE_URL (e.g. https://whisper-api.myia.io/v1). Supports ogg/opus
 * directly (faster-whisper decodes natively).
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<string | null> {
  const config = loadConfig();
  if (!config) return null;

  try {
    const mime = mimeType || mimeForExt(extFromName(filename));
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), filename);
    form.append('model', config.model);
    // language hint stops Whisper from misdetecting the language on short
    // clips (auto-detection is unreliable below ~5s of speech).
    if (config.language) form.append('language', config.language);
    if (config.prompt) form.append('prompt', config.prompt);

    const url = `${config.baseUrl}/audio/transcriptions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log.warn('Transcription request failed', { status: resp.status, body: body.slice(0, 200) });
      return null;
    }

    const data = (await resp.json()) as { text?: string };
    const text = (data.text || '').trim();
    if (!text) {
      log.debug('Transcription returned empty text', { filename });
      return null;
    }

    log.info('Transcribed voice message', { filename, chars: text.length });
    return text;
  } catch (err) {
    log.error('Transcription error', { filename, err });
    return null;
  }
}

function extFromName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.opus':
      return 'audio/opus';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.flac':
      return 'audio/flac';
    default:
      return 'application/octet-stream';
  }
}

/** For tests: reset cached config so env changes take effect. */
export function resetTranscriptionConfigForTests(): void {
  cachedConfig = undefined;
}
