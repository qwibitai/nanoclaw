/**
 * Voice/audio transcription via OpenRouter audio-capable models.
 * Reuses existing ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN from .env.
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const TRANSCRIPTION_MODEL = 'google/gemini-2.0-flash-001';

/**
 * Transcribe an audio buffer using OpenRouter's audio-capable model.
 * Returns the transcript text, or null on failure (caller falls back to placeholder).
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const env = readEnvFile(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  const baseUrl = process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || '';
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN || '';
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || '';

  // Need either OpenRouter (base_url + auth_token) or a direct key
  const token = authToken || apiKey;
  if (!token) {
    logger.warn('No API key available for transcription');
    return null;
  }

  // Build the API URL — OpenRouter or direct OpenAI-compatible endpoint
  const apiBase = baseUrl || 'https://openrouter.ai/api';
  const url = `${apiBase.replace(/\/+$/, '')}/v1/chat/completions`;

  const base64Audio = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Audio}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: TRANSCRIPTION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: {
                  data: base64Audio,
                  format: mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'mp4' : 'wav',
                },
              },
              {
                type: 'text',
                text: 'Transcribe this audio message exactly as spoken. Output only the transcript, nothing else.',
              },
            ],
          },
        ],
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      logger.warn(
        { status: response.status, error: errorText },
        'Transcription API error',
      );
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const transcript = data.choices?.[0]?.message?.content?.trim();

    if (!transcript) {
      logger.warn('Transcription returned empty result');
      return null;
    }

    logger.info(
      { length: transcript.length },
      'Audio transcribed successfully',
    );
    return transcript;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Transcription failed',
    );
    return null;
  }
}
