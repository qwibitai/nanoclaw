/**
 * Topic Classifier for Threadless Channels (WhatsApp/Telegram)
 *
 * Three-tier decision for whether to reset the session on a new message:
 * 1. Short-circuit SAME: last message < 5 min ago → skip classifier
 * 2. Heuristic reset: idle > 30 min → auto-reset without calling Haiku
 * 3. Ambiguous zone (5-30 min): call Haiku to classify topic change
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const SHORT_CIRCUIT_MINUTES = 5;
const HEURISTIC_RESET_MINUTES = 30;

interface ClassifierResult {
  reset: boolean;
  reason: 'short_circuit' | 'heuristic' | 'classifier' | 'user_override';
}

/**
 * Determine whether to reset the session based on idle time and topic analysis.
 */
export async function shouldResetSession(
  recentMessages: Array<{ content: string; is_from_me: boolean }>,
  newMessage: string,
  idleMinutes: number,
): Promise<ClassifierResult> {
  // Tier 1: Short-circuit SAME — very recent conversation
  if (idleMinutes < SHORT_CIRCUIT_MINUTES) {
    logger.debug(
      { idleMinutes },
      'Topic classifier: short-circuit SAME (recent)',
    );
    return { reset: false, reason: 'short_circuit' };
  }

  // Tier 2: Heuristic reset — long idle period
  if (idleMinutes >= HEURISTIC_RESET_MINUTES) {
    logger.debug(
      { idleMinutes },
      'Topic classifier: heuristic reset (long idle)',
    );
    return { reset: true, reason: 'heuristic' };
  }

  // Tier 3: Ambiguous zone — ask Haiku
  try {
    const result = await classifyWithHaiku(recentMessages, newMessage);
    logger.info(
      { idleMinutes, reset: result },
      'Topic classifier: Haiku decision',
    );
    return { reset: result, reason: 'classifier' };
  } catch (err) {
    logger.warn({ err }, 'Topic classifier: Haiku failed, defaulting to SAME');
    return { reset: false, reason: 'classifier' };
  }
}

/**
 * Check for user override commands in the message.
 * Returns 'new' (force reset), 'continue' (force same), or null (no override).
 */
export function checkUserOverride(content: string): 'new' | 'continue' | null {
  const trimmed = content.trim().toLowerCase();
  if (trimmed.includes('/new')) return 'new';
  if (trimmed.includes('/continue')) return 'continue';
  return null;
}

let cachedApiKey: string | undefined;
function getApiKey(): string {
  if (!cachedApiKey) {
    cachedApiKey = readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY;
  }
  if (!cachedApiKey) throw new Error('ANTHROPIC_API_KEY not available for topic classifier');
  return cachedApiKey;
}

async function classifyWithHaiku(
  recentMessages: Array<{ content: string; is_from_me: boolean }>,
  newMessage: string,
): Promise<boolean> {
  const apiKey = getApiKey();

  // Build context from recent messages (last 5)
  const context = recentMessages
    .slice(-5)
    .map(
      (m) =>
        `${m.is_from_me ? 'Assistant' : 'User'}: ${m.content.slice(0, 200)}`,
    )
    .join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: `Given this recent conversation:\n${context}\n\nIs this new message a continuation of the same topic, or a completely new topic?\nNew message: "${newMessage.slice(0, 300)}"\n\nReply with exactly one word: SAME or NEW`,
        },
      ],
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    throw new Error(`Haiku API error: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text =
    data.content
      ?.find((c) => c.type === 'text')
      ?.text?.trim()
      .toUpperCase() || '';

  return text.includes('NEW');
}
