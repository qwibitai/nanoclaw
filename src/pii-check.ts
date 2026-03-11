import { AnonymizeConfig } from './anonymize.js';
import { logger } from './logger.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:7b';
const TIMEOUT_MS = 30_000;

export interface PiiItem {
  text: string;
  type: string;
  suggestion: string;
}

export interface PiiResult {
  found: PiiItem[];
}

/**
 * Ask a local Ollama model to scan already-anonymized text for any remaining PII.
 * Returns found items, or null if clean / error / timeout / piiCheck disabled.
 */
export async function checkForPii(
  anonymizedText: string,
  config: AnonymizeConfig,
): Promise<PiiResult | null> {
  if (!config.piiCheck) return null;

  const model = config.piiModel || DEFAULT_MODEL;
  const knownPseudonyms = Object.values(config.mappings).join(', ');

  const prompt = `You are a PII detector. Analyze this message for any personally identifiable information (PII) that has NOT been anonymized. PII includes: real names, nicknames, dates of birth, addresses, postcodes, phone numbers, email addresses, hospital names, school names, social worker names, case reference numbers.

Known pseudonyms already in use (these are NOT PII — ignore them): ${knownPseudonyms}

Message to analyze:
"""
${anonymizedText}
"""

If you find PII, respond with JSON: {"found": [{"text": "the exact PII text", "type": "name|date|address|phone|email|other", "suggestion": "a plausible pseudonym"}]}
If no PII found, respond with: {"found": []}
Respond with ONLY valid JSON, nothing else.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Ollama returned status ${resp.status}`);
    }

    const body = (await resp.json()) as { response?: string };
    if (!body.response) {
      throw new Error('Ollama returned empty response');
    }

    // Extract JSON from response (model may include markdown fences)
    const jsonStr = body.response
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    const parsed = JSON.parse(jsonStr) as PiiResult;

    if (!Array.isArray(parsed.found)) {
      throw new Error(
        'Ollama returned malformed response (missing found array)',
      );
    }

    // Filter out any findings that are actually known pseudonyms
    const pseudonymSet = new Set(
      Object.values(config.mappings).map((v) => v.toLowerCase()),
    );
    parsed.found = parsed.found.filter(
      (item) => !pseudonymSet.has(item.text.toLowerCase()),
    );

    if (parsed.found.length === 0) return null;
    return parsed;
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Ollama request timed out (is the model loaded?)');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pre-load the Ollama model into memory so the first real PII check
 * doesn't pay the cold-start penalty (~20-30s model load).
 * Fire-and-forget — does not block startup.
 */
export function warmupPiiModel(config: AnonymizeConfig): void {
  if (!config.piiCheck) return;
  const model = config.piiModel || DEFAULT_MODEL;
  logger.info({ model }, 'pii-check: warming up Ollama model');
  fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'hi', stream: false }),
  }).catch((err) => {
    logger.warn(
      { err },
      'pii-check: warmup failed (Ollama may not be running)',
    );
  });
}

/** Format a PII alert message for the user. */
export function formatPiiAlert(result: PiiResult): string {
  const items = result.found
    .map(
      (item) =>
        `  - "${item.text}" (${item.type}) — suggest mapping to "${item.suggestion}"`,
    )
    .join('\n');

  return [
    'PII detected in pending message:',
    items,
    '',
    'Reply:',
    '  "approve" — add suggested mappings and send',
    '  "skip" — send without new mappings',
    '  "map X > Y" — use custom pseudonym (e.g. "map Livvy > Lulu")',
  ].join('\n');
}
