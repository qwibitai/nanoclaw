import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const MAX_TTS_CHARS = 4500;

let cachedConfig: { apiKey: string; voiceId: string } | null = null;

function getConfig(): { apiKey: string; voiceId: string } | null {
  if (cachedConfig) return cachedConfig;

  const env = readEnvFile(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
  const apiKey = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY || '';
  const voiceId =
    process.env.ELEVENLABS_VOICE_ID || env.ELEVENLABS_VOICE_ID || '';

  if (!apiKey) {
    logger.debug('ELEVENLABS_API_KEY not set, voice features disabled');
    return null;
  }

  cachedConfig = { apiKey, voiceId };
  return cachedConfig;
}

/**
 * Synthesize speech from text using ElevenLabs TTS.
 * Returns an OGG Opus buffer suitable for Telegram voice notes, or null on failure.
 */
export async function synthesizeSpeech(
  text: string,
): Promise<Buffer | null> {
  const config = getConfig();
  if (!config) return null;
  if (!config.voiceId) {
    logger.warn('ELEVENLABS_VOICE_ID not set, cannot synthesize speech');
    return null;
  }

  try {
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    const client = new ElevenLabsClient({ apiKey: config.apiKey });

    let input = text;
    if (input.length > MAX_TTS_CHARS) {
      logger.warn(
        { original: input.length, truncated: MAX_TTS_CHARS },
        'TTS input truncated',
      );
      input = input.slice(0, MAX_TTS_CHARS) + '…';
    }

    const audio = await client.textToSpeech.convert(config.voiceId, {
      text: input,
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'opus_48000_128',
    });

    // The SDK returns a ReadableStream — collect into a Buffer
    const chunks: Uint8Array[] = [];
    for await (const chunk of audio) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }

    const buffer = Buffer.concat(chunks);
    logger.info(
      { textLength: text.length, audioBytes: buffer.length },
      'TTS synthesis complete',
    );
    return buffer;
  } catch (err) {
    logger.error({ err }, 'ElevenLabs TTS failed');
    return null;
  }
}

/**
 * Transcribe audio using ElevenLabs STT (Scribe).
 * Returns the transcript string, or null on failure.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
): Promise<string | null> {
  const config = getConfig();
  if (!config) return null;

  try {
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    const client = new ElevenLabsClient({ apiKey: config.apiKey });

    const file = new File([audioBuffer], 'voice.ogg', {
      type: 'audio/ogg',
    });

    const result = await client.speechToText.convert({
      file,
      modelId: 'scribe_v1',
    });

    const transcript = result.text?.trim() || null;
    logger.info(
      { audioBytes: audioBuffer.length, transcriptLength: transcript?.length },
      'STT transcription complete',
    );
    return transcript;
  } catch (err) {
    logger.error({ err }, 'ElevenLabs STT failed');
    return null;
  }
}

/** Reset cached config — for testing only. */
export function _resetConfig(): void {
  cachedConfig = null;
}
