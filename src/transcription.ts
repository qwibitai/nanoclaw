import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
  includeMetadata: boolean;
}

interface AudioEvent {
  type: string;
  text: string;
  start?: number;
  end?: number;
}

interface TranscriptionMetadata {
  audioEvents: AudioEvent[];
  averageConfidence: number;
  languageCode: string;
  languageProbability: number;
  duration?: number;
  speakingPace?: string;
  sentiment?: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'scribe_v2',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
  includeMetadata: true,
};

function analyzeSentiment(
  audioEvents: AudioEvent[],
  averageConfidence: number,
): string | undefined {
  const eventTexts = audioEvents.map((e) => e.text.toLowerCase());

  // Check for emotional indicators
  const hasLaughter = eventTexts.some((t) =>
    t.includes('laugh') || t.includes('chuckle') || t.includes('giggle'),
  );
  const hasSighing = eventTexts.some((t) => t.includes('sigh'));
  const hasGroaning = eventTexts.some((t) => t.includes('groan'));

  // Low confidence might indicate hesitation or uncertainty
  const isHesitant = averageConfidence < 0.7;

  if (hasLaughter) return 'cheerful';
  if (hasSighing || hasGroaning) return 'concerned';
  if (isHesitant) return 'thoughtful';

  return undefined;
}

function calculateSpeakingPace(
  words: any[],
  duration?: number,
): string | undefined {
  if (!duration || words.length === 0) return undefined;

  const wordsPerSecond = words.length / duration;

  if (wordsPerSecond < 1.5) return 'slow';
  if (wordsPerSecond > 3.0) return 'fast';
  return 'normal';
}

function formatMetadata(metadata: TranscriptionMetadata): string {
  const parts: string[] = [];

  // Audio events
  if (metadata.audioEvents.length > 0) {
    const eventSummary = metadata.audioEvents
      .map((e) => e.text)
      .join(', ');
    parts.push(eventSummary);
  }

  // Confidence
  const confidencePercent = Math.round(metadata.averageConfidence * 100);
  if (confidencePercent < 90) {
    parts.push(`${confidencePercent}% confidence`);
  }

  // Speaking pace
  if (metadata.speakingPace && metadata.speakingPace !== 'normal') {
    parts.push(`${metadata.speakingPace} pace`);
  }

  // Sentiment
  if (metadata.sentiment) {
    parts.push(`tone: ${metadata.sentiment}`);
  }

  // Language (if not English)
  if (metadata.languageCode && metadata.languageCode !== 'eng') {
    parts.push(`language: ${metadata.languageCode}`);
  }

  return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

async function transcribeWithElevenLabs(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile(['ELEVENLABS_API_KEY']);
  const apiKey = env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    console.warn('ELEVENLABS_API_KEY not set in .env');
    return null;
  }

  try {
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    const client = new ElevenLabsClient({ apiKey });

    const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });

    const result = await client.speechToText.convert({
      file: audioBlob,
      modelId: config.model as 'scribe_v2',
      tagAudioEvents: true,
      diarize: false,
      timestampsGranularity: 'word',
    });

    if (!config.includeMetadata) {
      return result.text;
    }

    // Extract metadata from the full response
    const words = (result as any).words || [];
    const audioEvents: AudioEvent[] = [];
    let totalConfidence = 0;
    let confidenceCount = 0;

    // Analyze words for events and confidence
    for (const word of words) {
      if (word.type === 'audio_event') {
        audioEvents.push({
          type: 'audio_event',
          text: word.text,
          start: word.start,
          end: word.end,
        });
      }

      if (typeof word.logprob === 'number') {
        // Convert logprob to probability (0-1 range)
        const probability = Math.exp(word.logprob);
        totalConfidence += probability;
        confidenceCount++;
      }
    }

    const averageConfidence =
      confidenceCount > 0 ? totalConfidence / confidenceCount : 1.0;

    // Calculate duration
    const duration =
      words.length > 0 && words[words.length - 1].end
        ? words[words.length - 1].end
        : undefined;

    // Build metadata
    const metadata: TranscriptionMetadata = {
      audioEvents,
      averageConfidence,
      languageCode: (result as any).languageCode || 'eng',
      languageProbability: (result as any).languageProbability || 1.0,
      duration,
      speakingPace: calculateSpeakingPace(words, duration),
      sentiment: analyzeSentiment(audioEvents, averageConfidence),
    };

    const metadataString = formatMetadata(metadata);

    console.log(
      `Transcribed voice message: ${result.text.length} chars${metadataString}`,
    );

    return result.text.trim() + metadataString;
  } catch (err) {
    console.error('ElevenLabs transcription failed:', err);
    return null;
  }
}

export interface TranscriptionResult {
  transcript: string | null;
  audioBuffer: Buffer | null;
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<TranscriptionResult> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return { transcript: config.fallbackMessage, audioBuffer: null };
  }

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
      console.error('Failed to download audio message');
      return { transcript: config.fallbackMessage, audioBuffer: null };
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    const transcript = await transcribeWithElevenLabs(buffer, config);

    if (!transcript) {
      return { transcript: config.fallbackMessage, audioBuffer: buffer };
    }

    return { transcript: transcript.trim(), audioBuffer: buffer };
  } catch (err) {
    console.error('Transcription error:', err);
    return { transcript: config.fallbackMessage, audioBuffer: null };
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
