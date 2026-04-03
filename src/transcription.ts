/**
 * Voice message transcription using Groq's free Whisper API.
 * No npm deps needed — uses Node 22 native fetch + FormData.
 */
import { GROQ_API_KEY } from './config.js';
import { logger } from './logger.js';
import { resilientFetch } from './resilient-fetch.js';

const GROQ_TRANSCRIPTION_URL =
  'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

/**
 * Transcribe an audio buffer using Groq's Whisper API.
 * Returns the transcript text, or null on failure.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType = 'audio/ogg',
): Promise<string | null> {
  if (!GROQ_API_KEY) {
    logger.debug('GROQ_API_KEY not set, skipping voice transcription');
    return null;
  }

  try {
    // Determine file extension from mime type
    const ext = mimeType.includes('ogg')
      ? 'ogg'
      : mimeType.includes('mp4')
        ? 'm4a'
        : mimeType.includes('mpeg')
          ? 'mp3'
          : 'ogg';

    // Build multipart form data using native FormData
    const blob = new Blob([audioBuffer], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, `voice.${ext}`);
    formData.append('model', WHISPER_MODEL);

    const response = await resilientFetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: formData,
    }, { timeoutMs: 60_000, label: 'groq-whisper' });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, body: errorText },
        'Groq transcription failed',
      );
      return null;
    }

    const result = (await response.json()) as { text?: string };
    const transcript = result.text?.trim();

    if (!transcript) {
      logger.debug('Groq returned empty transcript');
      return null;
    }

    logger.info({ length: transcript.length }, 'Voice message transcribed');
    return transcript;
  } catch (err) {
    logger.error({ err }, 'Voice transcription error');
    return null;
  }
}

/**
 * Check if a Baileys message is a voice/PTT message.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isVoiceMessage(msg: { message?: any }): boolean {
  return !!msg.message?.audioMessage?.ptt;
}
