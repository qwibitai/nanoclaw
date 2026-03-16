import { AnonymizeConfig } from './anonymize.js';
import { logger } from './logger.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:7b';
const TIMEOUT_MS = 30_000;

export const PII_CMD_APPROVE = 'approve';
export const PII_CMD_SKIP = 'skip';
export const PII_CMD_MAP_PREFIX = 'map ';

export interface PiiItem {
  text: string;
  type: string;
  suggestion: string;
  /** Set when matchVariant detects this is likely a nickname of an existing mapping. */
  variantOf?: string;
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

If you find PII, respond with JSON: {"found": [{"text": "the exact PII text", "type": "name|date|address|phone|email|other"}]}
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

    // Generate pseudonyms: matchVariant for nicknames, generatePseudonym for new people
    const usedPseudonyms = new Set(Object.values(config.mappings));
    for (const item of parsed.found) {
      const match = matchVariant(item.text, config.mappings);
      if (match) {
        item.suggestion = match.pseudo;
        item.variantOf = match.real;
      } else {
        item.suggestion = generatePseudonym(usedPseudonyms);
        usedPseudonyms.add(item.suggestion); // prevent duplicates within batch
      }
    }

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

/** Pool of nature/object themed pseudonyms. Clearly not real names. */
const PSEUDONYM_POOL = [
  'Ember',
  'Azure',
  'Coral',
  'Sage',
  'River',
  'Cedar',
  'Ivory',
  'Jade',
  'Pearl',
  'Flint',
  'Hazel',
  'Onyx',
  'Robin',
  'Sterling',
  'Wren',
  'Briar',
  'Echo',
  'Fern',
  'Harbor',
  'Indigo',
  'Lark',
  'Maple',
  'Nova',
  'Orion',
  'Piper',
  'Reed',
  'Sable',
  'Terra',
  'Vale',
  'Willow',
];

/** Pick the next unused pseudonym from the pool. */
export function generatePseudonym(usedPseudonyms: Set<string>): string {
  const used = new Set([...usedPseudonyms].map((v) => v.toLowerCase()));
  for (const name of PSEUDONYM_POOL) {
    if (!used.has(name.toLowerCase())) return name;
  }
  // Fallback if pool exhausted
  return `Person${usedPseudonyms.size + 1}`;
}

/**
 * Deterministic variant detection using string similarity.
 * Returns the existing pseudonym + real name if the detected name is likely
 * a nickname or shortened form. Only matches on shared substring (≥3 chars)
 * or shared prefix (≥3 chars). This avoids the 7B model's tendency to
 * map every new name to the nearest existing pseudonym.
 */
export function matchVariant(
  detectedName: string,
  mappings: Record<string, string>,
): { pseudo: string; real: string } | null {
  const lower = detectedName.toLowerCase();
  if (lower.length < 3) return null;
  for (const [real, pseudo] of Object.entries(mappings)) {
    const realLower = real.toLowerCase();
    if (realLower.length < 3) continue;
    // Check for any shared 3-char window between the two names.
    // Catches: Livvy↔Olivia (share "liv"), Sim↔Simon (share "sim")
    // Rejects: Claire↔Olivia (no shared 3-char window)
    let matched = false;
    for (let i = 0; i <= lower.length - 3; i++) {
      if (realLower.includes(lower.slice(i, i + 3))) {
        matched = true;
        break;
      }
    }
    if (matched) return { pseudo, real };
  }
  return null;
}

/** Format a PII alert message for the user. */
export function formatPiiAlert(result: PiiResult): string {
  const items = result.found
    .map((item) => {
      const linkNote = item.variantOf ? ` (variant of ${item.variantOf})` : '';
      return `  - "${item.text}" (${item.type})${linkNote} — suggest mapping to "${item.suggestion}"`;
    })
    .join('\n');

  return [
    'PII detected in pending message:',
    items,
    '',
    'Reply:',
    `  "${PII_CMD_APPROVE}" — add suggested mappings and send`,
    `  "${PII_CMD_SKIP}" — send without new mappings`,
    `  "${PII_CMD_MAP_PREFIX}X > Y" — use custom pseudonym (e.g. "map Livvy > Lulu")`,
  ].join('\n');
}
