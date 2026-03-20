/**
 * Skill Validator
 * Safety checks and drift detection for behavioral skills.
 */
import { logger } from '../logger.js';

/** Forbidden patterns that skills must not contain */
const FORBIDDEN_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(?:a\s+)?(?:DAN|jailbreak)/i,
  /disregard\s+(?:your\s+)?(?:system|safety)\s+(?:prompt|instructions)/i,
  /override\s+(?:your\s+)?(?:core|system)\s+(?:instructions|prompt)/i,
  /forget\s+(?:all\s+)?(?:your\s+)?(?:rules|constraints|instructions)/i,
];

/**
 * Check if skill content contains forbidden patterns.
 * Returns an error message if forbidden, null if safe.
 */
export function checkForbiddenPatterns(content: string): string | null {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) {
      return `Forbidden pattern detected: ${pattern.source}`;
    }
  }
  return null;
}

/**
 * Calculate word-level drift between two strings.
 * Returns a percentage (0.0 to 1.0) of words changed.
 */
export function calculateDrift(oldContent: string, newContent: string): number {
  const oldWords = oldContent.split(/\s+/).filter(Boolean);
  const newWords = newContent.split(/\s+/).filter(Boolean);

  if (oldWords.length === 0 && newWords.length === 0) return 0;
  if (oldWords.length === 0) return 1;

  // Simple word-level diff: count words that changed
  const maxLen = Math.max(oldWords.length, newWords.length);
  let changed = Math.abs(oldWords.length - newWords.length);

  const minLen = Math.min(oldWords.length, newWords.length);
  for (let i = 0; i < minLen; i++) {
    if (oldWords[i] !== newWords[i]) {
      changed++;
    }
  }

  return changed / maxLen;
}

/**
 * Validate a skill modification.
 * Returns null if valid, or an error message if invalid.
 */
export function validateSkillModification(
  oldContent: string,
  newContent: string,
  maxDrift: number = 0.3,
): string | null {
  // Check for forbidden patterns
  const forbidden = checkForbiddenPatterns(newContent);
  if (forbidden) return forbidden;

  // Check drift limit
  const drift = calculateDrift(oldContent, newContent);
  if (drift > maxDrift) {
    return `Word-level drift ${(drift * 100).toFixed(1)}% exceeds max ${(maxDrift * 100).toFixed(1)}%`;
  }

  return null;
}

/**
 * Validate new skill content (no drift check needed).
 */
export function validateNewSkill(content: string): string | null {
  const forbidden = checkForbiddenPatterns(content);
  if (forbidden) return forbidden;

  if (content.trim().length < 20) {
    return 'Skill content too short (minimum 20 characters)';
  }

  return null;
}

/**
 * Check if a skill's performance has declined enough to trigger rollback.
 * Returns true if rollback should happen.
 */
export function shouldRollback(
  parentAvgScore: number,
  currentAvgScore: number,
  threshold: number = 0.2,
): boolean {
  if (parentAvgScore === 0) return false;
  const decline = (parentAvgScore - currentAvgScore) / parentAvgScore;
  if (decline > threshold) {
    logger.warn(
      { parentAvgScore, currentAvgScore, decline },
      'Skill score decline exceeds rollback threshold',
    );
    return true;
  }
  return false;
}
