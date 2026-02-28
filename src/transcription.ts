import OpenAI from 'openai';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (client) return client;

  const { OPENAI_API_KEY } = readEnvFile(['OPENAI_API_KEY']);
  if (!OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not set — voice transcription disabled');
    return null;
  }
  client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return client;
}

export async function transcribeAudio(
  buffer: Buffer,
  filename = 'voice.ogg',
): Promise<string | null> {
  const openai = getClient();
  if (!openai) return null;

  try {
    const file = new File([buffer], filename, { type: 'audio/ogg' });
    const response = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
    });

    logger.info({ chars: response.text.length }, 'Transcribed voice message');
    return response.text;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}
