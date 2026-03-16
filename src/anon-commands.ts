import { addMapping, AnonymizeConfig, removeMapping } from './anonymize.js';

// --- Intent types ---

export type AnonIntent =
  | { intent: 'list' }
  | { intent: 'lookup'; name: string }
  | { intent: 'add'; real: string; pseudonym: string }
  | { intent: 'remove'; name: string }
  | { intent: 'help' };

// --- Keyword sets ---

const LIST_KEYWORDS = ['list', 'show', 'all', 'table', 'mappings', 'full'];
const ADD_KEYWORDS = ['add', 'map', 'set'];
const REMOVE_KEYWORDS = ['remove', 'delete', 'drop', 'unmap'];

// Separators for "add" intent: X > Y, X to Y, X as Y, X = Y, X → Y
const ADD_SEPARATOR = /\s*(?:>|→|=>|->|=)\s*|\s+(?:to|as)\s+/i;

/**
 * Parse natural-language text (after the "anon" prefix) into a structured intent.
 * Uses keyword matching and falls back to name lookup if no keyword is found.
 */
export function parseAnonIntent(
  text: string,
  mappings: Record<string, string>,
): AnonIntent {
  const trimmed = text.trim();
  if (!trimmed || /^help$/i.test(trimmed) || trimmed === '?') {
    return { intent: 'help' };
  }

  const lower = trimmed.toLowerCase();
  const words = lower.split(/\s+/);

  // Check for remove intent first (before add, since "remove" is unambiguous)
  if (words.some((w) => REMOVE_KEYWORDS.includes(w))) {
    const name = extractNameAfterKeywords(trimmed, REMOVE_KEYWORDS);
    if (name) return { intent: 'remove', name };
  }

  // Check for add intent: needs a separator (X > Y, X to Y, X as Y)
  if (
    words.some((w) => ADD_KEYWORDS.includes(w)) ||
    ADD_SEPARATOR.test(trimmed)
  ) {
    const parsed = parseAddIntent(trimmed);
    if (parsed) return parsed;
  }

  // Check for list intent
  if (words.some((w) => LIST_KEYWORDS.includes(w))) {
    // If there's also a name match, prefer lookup
    const lookupName = findNameInMappings(trimmed, mappings);
    if (lookupName) return { intent: 'lookup', name: lookupName };
    return { intent: 'list' };
  }

  // Fallback: try to match a name in mappings (lookup by name alone)
  const lookupName = findNameInMappings(trimmed, mappings);
  if (lookupName) return { intent: 'lookup', name: lookupName };

  return { intent: 'help' };
}

/**
 * Extract a name from text after stripping known keywords.
 * E.g. "remove the mapping for Claire" → "Claire"
 */
function extractNameAfterKeywords(
  text: string,
  keywords: string[],
): string | null {
  let cleaned = text;
  for (const kw of keywords) {
    cleaned = cleaned.replace(new RegExp(`\\b${kw}\\b`, 'gi'), '');
  }
  // Strip filler words
  cleaned = cleaned
    .replace(/\b(the|mapping|for|of|entry)\b/gi, '')
    .trim()
    .replace(/\s+/g, ' ');
  return cleaned || null;
}

/**
 * Parse add intent from text like "add Claire as Ember", "Claire > Ember", "map Rich to Azure".
 */
function parseAddIntent(text: string): AnonIntent | null {
  // Strip add/map/set keywords
  let cleaned = text;
  for (const kw of ADD_KEYWORDS) {
    cleaned = cleaned.replace(new RegExp(`\\b${kw}\\b`, 'gi'), '');
  }
  // Strip filler words
  cleaned = cleaned
    .replace(/\b(a|the|new|mapping|for|of|entry)\b/gi, '')
    .trim()
    .replace(/\s+/g, ' ');

  // Split on separator
  const parts = cleaned.split(ADD_SEPARATOR);
  if (parts.length === 2) {
    const real = parts[0].trim();
    const pseudonym = parts[1].trim();
    if (real && pseudonym) return { intent: 'add', real, pseudonym };
  }
  return null;
}

/**
 * Find a name (real or pseudonym) in the mappings that appears in the text.
 * Returns the canonical form (as stored in mappings), or null.
 */
function findNameInMappings(
  text: string,
  mappings: Record<string, string>,
): string | null {
  const lower = text.toLowerCase();
  // Strip common filler words to isolate the name
  const cleaned = lower
    .replace(
      /\b(who|is|what|what's|whats|mapped|to|the|mapping|for|of|lookup|look|up|show|me)\b/g,
      '',
    )
    .trim()
    .replace(/[?!.,]/g, '')
    .trim();

  // Check real names (keys) and pseudonyms (values)
  for (const [real, pseudo] of Object.entries(mappings)) {
    if (
      cleaned === real.toLowerCase() ||
      cleaned.includes(real.toLowerCase())
    ) {
      return real;
    }
    if (
      cleaned === pseudo.toLowerCase() ||
      cleaned.includes(pseudo.toLowerCase())
    ) {
      return pseudo;
    }
  }
  return null;
}

// --- Response formatting ---

export function formatListResponse(
  mappings: Record<string, string>,
  groupFolder: string,
): string {
  const entries = Object.entries(mappings);
  if (entries.length === 0) {
    return `No anonymisation mappings configured (${groupFolder}).`;
  }
  const lines = entries.map(([real, pseudo]) => `  ${real} → ${pseudo}`);
  return [
    `Anonymisation mappings (${groupFolder}):`,
    ...lines,
    `(${entries.length} mapping${entries.length === 1 ? '' : 's'})`,
  ].join('\n');
}

export function formatLookupResponse(
  name: string,
  mappings: Record<string, string>,
): string {
  // Check as real name (key)
  for (const [real, pseudo] of Object.entries(mappings)) {
    if (real.toLowerCase() === name.toLowerCase()) {
      return `${real} → ${pseudo}`;
    }
  }
  // Check as pseudonym (value)
  for (const [real, pseudo] of Object.entries(mappings)) {
    if (pseudo.toLowerCase() === name.toLowerCase()) {
      return `${pseudo} ← ${real}`;
    }
  }
  return `"${name}" not found in mappings.`;
}

// --- Command handler ---

/**
 * Handle an anon command intent. Performs side effects (add/remove mapping)
 * and returns the response string to send back to the user.
 */
export async function handleAnonCommand(
  intent: AnonIntent,
  groupFolder: string,
  config: AnonymizeConfig,
): Promise<string> {
  switch (intent.intent) {
    case 'list':
      return formatListResponse(config.mappings, groupFolder);

    case 'lookup':
      return formatLookupResponse(intent.name, config.mappings);

    case 'add': {
      addMapping(groupFolder, intent.real, intent.pseudonym);
      return `Added mapping: ${intent.real} → ${intent.pseudonym}`;
    }

    case 'remove': {
      // Find the real key (user might pass real name or pseudonym)
      let realKey: string | null = null;
      let pseudo: string | null = null;
      for (const [r, p] of Object.entries(config.mappings)) {
        if (
          r.toLowerCase() === intent.name.toLowerCase() ||
          p.toLowerCase() === intent.name.toLowerCase()
        ) {
          realKey = r;
          pseudo = p;
          break;
        }
      }
      if (!realKey || !pseudo) {
        return `"${intent.name}" not found in mappings.`;
      }
      const removed = removeMapping(groupFolder, realKey);
      if (!removed) {
        return `Failed to remove mapping for "${intent.name}".`;
      }
      return `Removed mapping: ${realKey} → ${pseudo}`;
    }

    case 'help':
      return [
        'Anonymisation commands (prefix with "anon"):',
        '  "anon list" — show all mappings',
        '  "anon Claire" — look up a specific name',
        '  "anon add Claire as Ember" — add a mapping',
        '  "anon remove Claire" — remove a mapping',
      ].join('\n');
  }
}
