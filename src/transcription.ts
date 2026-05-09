/**
 * Voice message transcription using OpenAI's Whisper API.
 *
 * Downloads the audio file, sends it to OpenAI's transcription endpoint,
 * and returns the text. Falls back gracefully if the API key is missing
 * or the transcription fails.
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';

function getOpenAIKey(): string | null {
  const key = process.env.OPENAI_API_KEY || readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
  return key || null;
}

/**
 * Transcribe an audio buffer using OpenAI Whisper.
 *
 * @param audioBuffer Raw audio data (ogg/opus from Telegram voice notes)
 * @param filename    Filename hint for the API (e.g. "voice.ogg")
 * @returns Transcribed text, or null on failure
 */
export async function transcribeAudio(audioBuffer: Buffer, filename = 'voice.ogg'): Promise<string | null> {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    log.warn('OPENAI_API_KEY not set, cannot transcribe voice message');
    return null;
  }

  try {
    // Build multipart/form-data manually to avoid pulling in a dep.
    const boundary = `----NanoClawBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    // file field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`,
      ),
    );
    parts.push(audioBuffer);
    parts.push(Buffer.from('\r\n'));

    // model field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.error('OpenAI transcription failed', { status: res.status, body: errText.slice(0, 300) });
      return null;
    }

    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim();
    if (text) {
      log.info('Transcribed voice message', { chars: text.length });
    }
    return text || null;
  } catch (err) {
    log.error('Voice transcription error', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
