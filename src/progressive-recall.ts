/**
 * Progressive Recall — layered search instead of raw result dump.
 *
 * Stage 1: Return summaries (first meaningful line + file path + score + category).
 * Stage 2: Agent requests full content of specific files via recall_detail.
 *
 * Pure functions — no I/O, no side effects. Used by the container's recall
 * tool and testable independently.
 */

// ---------------------------------------------------------------------------
// Category detection — infers category from file path
// ---------------------------------------------------------------------------

export type RecallCategory =
  | 'observation'
  | 'learning'
  | 'knowledge'
  | 'daily'
  | 'project'
  | 'conversation'
  | 'memory'
  | 'unknown';

const CATEGORY_PATTERNS: Array<[RegExp, RecallCategory]> = [
  [/\bobservations?\b/i, 'observation'],
  [/\blearnings?\b/i, 'learning'],
  [/\bknowledge\b/i, 'knowledge'],
  [/\bdaily\b/i, 'daily'],
  [/\bprojects?\b/i, 'project'],
  [/\bconversations?\b/i, 'conversation'],
  [/\bmemory\b/i, 'memory'],
];

export function detectCategory(filePath: string): RecallCategory {
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(filePath)) return category;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Priority detection — extracts priority marker from observation text
// ---------------------------------------------------------------------------

export type Priority = 'critical' | 'useful' | 'noise' | null;

const PRIORITY_PATTERNS: Array<[RegExp, Priority]> = [
  [/\u{1F534}\s*Critical/u, 'critical'],
  [/\u{1F7E1}\s*Useful/u, 'useful'],
  [/\u{1F7E2}\s*Noise/u, 'noise'],
];

export function detectPriority(text: string): Priority {
  for (const [pattern, priority] of PRIORITY_PATTERNS) {
    if (pattern.test(text)) return priority;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Summary extraction — first meaningful line from content
// ---------------------------------------------------------------------------

const SKIP_PATTERNS = [
  /^<!--.*-->$/, // HTML comments
  /^---$/, // YAML frontmatter delimiters
  /^\s*$/, // empty lines
  /^#\s*$/, // empty headings
];

/**
 * Extract the first meaningful line from a text block.
 * Skips HTML comments, frontmatter delimiters, empty lines.
 * Returns at most `maxLength` characters.
 */
export function extractFirstLine(text: string, maxLength = 120): string {
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (SKIP_PATTERNS.some((p) => p.test(trimmed))) continue;

    if (trimmed.length <= maxLength) return trimmed;
    return trimmed.slice(0, maxLength - 3) + '...';
  }

  return '(empty)';
}

// ---------------------------------------------------------------------------
// Summary formatting — one-line summary for layered mode
// ---------------------------------------------------------------------------

export interface RecallSummary {
  file: string;
  score: number;
  category: RecallCategory;
  priority: Priority;
  firstLine: string;
}

export interface BM25ResultInput {
  file: string;
  snippet: string;
  score: number;
}

/**
 * Convert a BM25 result into a compact summary for layered recall.
 */
export function summarizeResult(result: BM25ResultInput): RecallSummary {
  return {
    file: result.file,
    score: result.score,
    category: detectCategory(result.file),
    priority: detectPriority(result.snippet),
    firstLine: extractFirstLine(result.snippet),
  };
}

/**
 * Format a list of BM25 results as layered summaries.
 * Compact output: ~500 tokens for 20 results vs ~5000 for full snippets.
 */
export function formatLayeredResults(
  results: BM25ResultInput[],
  query: string,
): string {
  if (results.length === 0) return `No results for "${query}".`;

  const summaries = results.map(summarizeResult);

  let output = `## Recall: "${query}" (${results.length} results, layered mode)\n`;
  output += `_Use recall_detail with a file path to see full content._\n\n`;

  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    const tags: string[] = [];
    if (s.category !== 'unknown') tags.push(s.category);
    if (s.priority) tags.push(`${s.priority}`);
    const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

    output += `${i + 1}. **${s.file}** (${s.score})${tagStr}\n`;
    output += `   ${s.firstLine}\n`;
  }

  return output;
}

/**
 * Format results in full mode (current behavior — full snippets).
 */
export function formatFullResults(
  results: BM25ResultInput[],
  query: string,
): string {
  if (results.length === 0) return `No results for "${query}".`;

  let output = `## Recall results for "${query}"\n\n`;
  for (const r of results) {
    output += `**${r.file}** (score: ${r.score})\n\`\`\`\n${r.snippet}\n\`\`\`\n\n`;
  }
  return output;
}
