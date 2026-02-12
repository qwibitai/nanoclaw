/**
 * voice.ts — Voice note preprocessing and validation.
 *
 * Pure function module: validates audio size/duration, calls Sarvam AI
 * for transcription, returns result. No DB access or side effects.
 */
import { logger } from './logger.js';

/** Result from processing a voice note. */
export interface VoiceResult {
  status: 'transcript' | 'rejected' | 'error';
  text?: string;
  message?: string;
}

/** Configuration for voice processing. */
export interface VoiceConfig {
  sarvamApiKey: string;
  sarvamUrl: string;
  maxSizeBytes: number;
  maxDurationSeconds: number;
}

/** Get the default VoiceConfig. */
export function getDefaultVoiceConfig(): VoiceConfig {
  return {
    sarvamApiKey: process.env.SARVAM_API_KEY || '',
    sarvamUrl:
      process.env.SARVAM_URL || 'https://api.sarvam.ai/speech-to-text',
    maxSizeBytes: 1_048_576,
    maxDurationSeconds: 120,
  };
}

/**
 * Parse OGG container for audio duration.
 * Returns duration in seconds, or null if header cannot be parsed.
 */
export function parseOggDuration(buffer: Buffer): number | null {
  if (buffer.length < 27 || buffer.toString('ascii', 0, 4) !== 'OggS') {
    return null;
  }

  let lastGranule = 0n;
  let offset = 0;

  while (offset < buffer.length - 27) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') {
      offset++;
      continue;
    }

    const granule = buffer.readBigInt64LE(offset + 6);
    if (granule > 0n) {
      lastGranule = granule;
    }

    // Skip to next page: read segment count and segment sizes
    const numSegments = buffer[offset + 26];
    let pageSize = 27 + numSegments;
    for (let i = 0; i < numSegments; i++) {
      pageSize += buffer[offset + 27 + i];
    }
    offset += pageSize;
  }

  if (lastGranule === 0n) return null;

  const sampleRate = 48000;
  return Number(lastGranule) / sampleRate;
}

// --- Multilingual messages ---

function getRejectionMessage(language: string): string {
  if (language === 'hi') {
    return 'कृपया अपनी शिकायत 2 मिनट में बताएं। आपका वॉइस मैसेज बहुत लंबा है।';
  }
  if (language === 'en') {
    return 'Please keep your voice message under 2 minutes. Your message was too long.';
  }
  return 'कृपया तुमची तक्रार २ मिनिटांत सांगा. तुमचा व्हॉइस मेसेज खूप मोठा आहे.';
}

function getErrorMessage(language: string): string {
  if (language === 'hi') {
    return 'मुझे आपका वॉइस मैसेज समझ नहीं आया। कृपया लिखकर भेजें।';
  }
  if (language === 'en') {
    return "I couldn't understand your voice message. Please type your complaint.";
  }
  return 'मला तुमचा आवाज समजला नाही. कृपया लिहून पाठवा.';
}

// --- Language code mapping (our codes → Sarvam BCP-47) ---

function toSarvamLanguageCode(lang: string): string {
  const map: Record<string, string> = {
    mr: 'mr-IN',
    hi: 'hi-IN',
    en: 'en-IN',
  };
  return map[lang] || 'unknown';
}

// --- Sarvam AI transcription ---

async function transcribeAudio(
  audioBuffer: Buffer,
  language: string,
  config: VoiceConfig,
): Promise<{ text: string; detectedLanguage?: string } | { error: string }> {
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), 'voice.ogg');
  formData.append('model', 'saaras:v3');

  const sarvamLang = toSarvamLanguageCode(language);
  if (sarvamLang !== 'unknown') {
    formData.append('language_code', sarvamLang);
  }

  const response = await fetch(config.sarvamUrl, {
    method: 'POST',
    headers: {
      'api-subscription-key': config.sarvamApiKey,
    },
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      error: `Sarvam HTTP ${response.status}: ${response.statusText} ${body}`,
    };
  }

  const result = (await response.json()) as {
    transcript: string;
    language_code?: string;
  };
  return { text: result.transcript, detectedLanguage: result.language_code };
}

/**
 * Validate and transcribe a voice note.
 */
export async function processVoiceNote(
  audioBuffer: Buffer,
  language: string,
  messageId: string,
  config: VoiceConfig,
): Promise<VoiceResult> {
  // Size guard
  if (audioBuffer.length > config.maxSizeBytes) {
    return { status: 'rejected', message: getRejectionMessage(language) };
  }

  // Duration guard (best-effort — proceed if OGG parse fails)
  const duration = parseOggDuration(audioBuffer);
  if (duration !== null && duration > config.maxDurationSeconds) {
    return { status: 'rejected', message: getRejectionMessage(language) };
  }

  // API key check
  if (!config.sarvamApiKey) {
    logger.error({ messageId }, 'SARVAM_API_KEY not configured');
    return { status: 'error', message: getErrorMessage(language) };
  }

  // Transcribe via Sarvam AI
  try {
    const result = await transcribeAudio(audioBuffer, language, config);

    if ('error' in result) {
      logger.error(
        { messageId, error: result.error },
        'Sarvam transcription HTTP error',
      );
      return { status: 'error', message: getErrorMessage(language) };
    }

    if (!result.text || result.text.trim() === '') {
      logger.warn({ messageId }, 'Sarvam returned empty transcript');
      return { status: 'error', message: getErrorMessage(language) };
    }

    logger.info(
      {
        messageId,
        transcript: result.text,
        language,
        detectedLanguage: result.detectedLanguage,
      },
      'Sarvam transcription result',
    );
    return { status: 'transcript', text: result.text };
  } catch (err) {
    logger.error({ err, messageId }, 'Sarvam transcription failed');
    return { status: 'error', message: getErrorMessage(language) };
  }
}
