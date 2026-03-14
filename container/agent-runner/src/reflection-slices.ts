/**
 * Markdown parsing, bullet extraction, injection safety,
 * and invariant/derived classification for reflection slices.
 *
 * Ported from memory-lancedb-pro.
 */

// ============================================================================
// Types
// ============================================================================

export interface ReflectionSlice {
  /** The extracted text content */
  text: string;
  /** Classification: invariant (stable truth) or derived (inferred, may change) */
  classification: 'invariant' | 'derived';
  /** Source line number in the original text */
  lineNumber: number;
  /** Confidence in the classification */
  confidence: number;
}

// ============================================================================
// Extraction
// ============================================================================

/**
 * Extract reflection slices from markdown text.
 * Parses bullet points, numbered lists, and standalone sentences.
 */
export function extractSlices(text: string): ReflectionSlice[] {
  if (!text) return [];

  const lines = text.split('\n');
  const slices: ReflectionSlice[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 10) continue;

    // Skip markdown headers (they're structural, not content)
    if (/^#{1,6}\s/.test(line)) continue;

    // Skip code blocks
    if (line.startsWith('```')) continue;

    // Skip horizontal rules
    if (/^[-*_]{3,}$/.test(line)) continue;

    // Extract content from bullet points
    const bulletMatch = line.match(/^[-*+]\s+(.+)/);
    const numberedMatch = line.match(/^\d+[.)]\s+(.+)/);
    const content = bulletMatch?.[1] || numberedMatch?.[1] || line;

    // Safety: skip injection attempts
    if (containsInjection(content)) continue;

    const classification = classifySlice(content);
    const confidence = computeSliceConfidence(content);

    slices.push({
      text: content,
      classification,
      lineNumber: i + 1,
      confidence,
    });
  }

  return slices;
}

// ============================================================================
// Classification
// ============================================================================

/** Invariant indicators: stable truths that don't change */
const INVARIANT_PATTERNS: RegExp[] = [
  /\b(always|never|must|required|mandatory|essential|fundamental)\b/i,
  /\b(rule|principle|law|axiom|truth|fact)\b/i,
  /\b(name\s+is|born\s+in|lives?\s+in|works?\s+(at|for))\b/i,
];

/** Derived indicators: inferred conclusions that may change */
const DERIVED_PATTERNS: RegExp[] = [
  /\b(seems?|appears?|likely|probably|might|may|could|suggests?)\b/i,
  /\b(currently|recently|lately|right\s+now|at\s+the\s+moment)\b/i,
  /\b(tend\s+to|usually|often|sometimes|occasionally)\b/i,
  /\b(inferred?|deduced?|concluded|assumed?|guessed?)\b/i,
];

function classifySlice(text: string): 'invariant' | 'derived' {
  let invariantScore = 0;
  let derivedScore = 0;

  for (const pattern of INVARIANT_PATTERNS) {
    if (pattern.test(text)) invariantScore++;
  }

  for (const pattern of DERIVED_PATTERNS) {
    if (pattern.test(text)) derivedScore++;
  }

  return invariantScore > derivedScore ? 'invariant' : 'derived';
}

function computeSliceConfidence(text: string): number {
  let confidence = 0.5;

  // Longer, more detailed slices are higher confidence
  if (text.length > 50) confidence += 0.1;
  if (text.length > 100) confidence += 0.1;

  // Specific details boost confidence
  if (/\b\d{4}\b/.test(text)) confidence += 0.05; // years
  if (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(text)) confidence += 0.05; // proper names

  // Hedging language reduces confidence
  if (/\b(maybe|perhaps|possibly|uncertain)\b/i.test(text)) confidence -= 0.15;

  return Math.max(0.1, Math.min(1.0, confidence));
}

// ============================================================================
// Safety
// ============================================================================

/** Patterns that suggest prompt injection attempts */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore\s+(previous|all|above)\s+(instructions?|prompts?))\b/i,
  /\b(you\s+are\s+now|new\s+instructions?|override\s+your)\b/i,
  /\b(system\s+prompt|jailbreak|bypass\s+safety)\b/i,
  /<\/?script\b/i,
  /\{\{.*\}\}/,
];

function containsInjection(text: string): boolean {
  return INJECTION_PATTERNS.some(pattern => pattern.test(text));
}
