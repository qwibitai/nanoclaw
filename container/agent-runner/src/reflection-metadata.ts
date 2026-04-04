/**
 * Reflection entry identification and display category tags.
 * Ported from memory-lancedb-pro.
 */

// ============================================================================
// Types
// ============================================================================

/** Reflection kinds determine decay and scoring behavior */
export type ReflectionKind = 'decision' | 'user-model' | 'agent-model' | 'lesson' | 'pattern' | 'meta';

/** Display-friendly category tags */
export const REFLECTION_DISPLAY_TAGS: Record<ReflectionKind, string> = {
  decision: '🎯 Decision',
  'user-model': '👤 User Model',
  'agent-model': '🤖 Agent Model',
  lesson: '📖 Lesson',
  pattern: '🔄 Pattern',
  meta: '🧠 Meta',
};

/**
 * Determine if a memory entry is a reflection.
 */
export function isReflectionEntry(category: string, metadata?: string): boolean {
  if (category === 'reflection') return true;

  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      return parsed.memory_category === 'patterns' || parsed.source === 'reflection';
    } catch { /* ignore */ }
  }

  return false;
}

/**
 * Infer reflection kind from text content.
 */
export function inferReflectionKind(text: string): ReflectionKind {
  const lower = text.toLowerCase();

  if (/\b(decided|decision|chose|choose|opted|selected)\b/.test(lower)) return 'decision';
  if (/\b(user\s+(prefers?|wants?|likes?|needs?)|they\s+(prefer|want|like|need))\b/.test(lower)) return 'user-model';
  if (/\b(i\s+(should|learned|realized|noticed)|my\s+(approach|strategy|method))\b/.test(lower)) return 'agent-model';
  if (/\b(lesson|takeaway|key\s+insight|important\s+to|never\s+forget)\b/.test(lower)) return 'lesson';
  if (/\b(pattern|recurring|repeatedly|always|every\s+time|consistently)\b/.test(lower)) return 'pattern';

  return 'meta';
}

/**
 * Get display tag for a reflection kind.
 */
export function getReflectionDisplayTag(kind: ReflectionKind): string {
  return REFLECTION_DISPLAY_TAGS[kind] || '🧠 Meta';
}
