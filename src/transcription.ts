import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Transcribe an audio buffer using OpenAI's Whisper API.
 *
 * Returns the transcript string, or null if:
 * - OPENAI_API_KEY is not configured
 * - The API call fails
 *
 * The caller is responsible for fallback messaging.
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping voice transcription');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });
    const file = await toFile(buffer, filename, { type: 'audio/ogg' });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'text',
    });

    return (transcription as unknown as string).trim();
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}
