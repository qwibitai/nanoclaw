import speech from '@google-cloud/speech';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

// Google auth library reads GOOGLE_APPLICATION_CREDENTIALS from process.env.
// Since .env is intentionally not loaded into process.env, we set it explicitly.
const { GOOGLE_APPLICATION_CREDENTIALS } = readEnvFile([
  'GOOGLE_APPLICATION_CREDENTIALS',
]);
if (GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = GOOGLE_APPLICATION_CREDENTIALS;
}

let client: speech.SpeechClient | null = null;

function getClient(): speech.SpeechClient {
  if (!client) client = new speech.SpeechClient();
  return client;
}

export async function transcribeAudio(buffer: Buffer): Promise<string | null> {
  const [operation] = await getClient().longRunningRecognize({
    audio: { content: buffer.toString('base64') },
    config: {
      encoding: 'OGG_OPUS',
      sampleRateHertz: 16000,
      languageCode: 'pt-BR',
      alternativeLanguageCodes: ['en-US', 'es-ES'],
      enableAutomaticPunctuation: true,
    },
  });
  const [response] = await operation.promise();

  const transcription = response.results
    ?.map((r) => r.alternatives?.[0]?.transcript)
    .filter(Boolean)
    .join(' ')
    .trim();

  if (!transcription) {
    logger.warn('Google STT returned empty transcription');
    return null;
  }

  return transcription;
}
