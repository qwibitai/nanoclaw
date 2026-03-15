/**
 * Message complexity classifier for model routing.
 *
 * Makes a lightweight Haiku call to classify an incoming message as
 * 'simple' (→ Haiku) or 'complex' (→ Sonnet) before spawning a container.
 *
 * Only used when a group has no explicit model configured.
 * Falls back to 'complex' (Sonnet) on any error.
 */
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const SIMPLE_MODEL = 'claude-haiku-4-5-20251001';
const COMPLEX_MODEL = 'claude-sonnet-4-6';

const CLASSIFIER_PROMPT = `Classify the following user message as either "simple" or "complex".

Simple: factual questions, greetings, short reminders, translations, brief summaries, scheduling, weather, time, basic lookups.
Complex: coding, debugging, multi-step research, file analysis, reasoning across multiple topics, writing long content.

Reply with exactly one word: simple or complex.

Message:
`;

export type Complexity = 'simple' | 'complex';

interface ClassifierResult {
  complexity: Complexity;
  model: string;
  reason: 'classified' | 'fallback_error' | 'fallback_explicit';
}

/**
 * Classify a message and return the recommended model.
 * Always returns a result — falls back to Sonnet on error.
 */
export async function classifyAndSelectModel(
  prompt: string,
  groupName: string,
): Promise<string> {
  const result = await classify(prompt, groupName);
  return result.model;
}

async function classify(
  prompt: string,
  groupName: string,
): Promise<ClassifierResult> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

  const apiKey = secrets.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn(
      { group: groupName },
      'Classifier: no API key found, falling back to Sonnet',
    );
    return {
      complexity: 'complex',
      model: COMPLEX_MODEL,
      reason: 'fallback_error',
    };
  }

  const baseUrl = secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

  // Truncate prompt to keep classifier call cheap
  const truncated = prompt.slice(0, 800);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 5,
        messages: [
          {
            role: 'user',
            content: CLASSIFIER_PROMPT + truncated,
          },
        ],
      }),
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!response.ok) {
      const body = await response.text();
      logger.warn(
        { group: groupName, status: response.status, body: body.slice(0, 200) },
        'Classifier: API error, falling back to Sonnet',
      );
      return {
        complexity: 'complex',
        model: COMPLEX_MODEL,
        reason: 'fallback_error',
      };
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = data.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .toLowerCase()
      .trim();

    const complexity: Complexity = text.startsWith('simple')
      ? 'simple'
      : 'complex';
    const model = complexity === 'simple' ? SIMPLE_MODEL : COMPLEX_MODEL;

    logger.info(
      { group: groupName, complexity, model, classifierRaw: text },
      'Classifier: decision',
    );

    return { complexity, model, reason: 'classified' };
  } catch (err) {
    logger.warn(
      { group: groupName, err },
      'Classifier: exception, falling back to Sonnet',
    );
    return {
      complexity: 'complex',
      model: COMPLEX_MODEL,
      reason: 'fallback_error',
    };
  }
}
