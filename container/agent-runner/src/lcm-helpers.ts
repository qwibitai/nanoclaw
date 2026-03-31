/**
 * LCM helper functions extracted for testability.
 * index.ts imports from this module; tests can import directly without triggering main().
 */

import {
  initLcmDatabase,
  getSummariesForConversation,
} from './lcm-store.js';

// --- Types ---

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

// --- Configuration ---

const LCM_CONTEXT_WINDOW_FALLBACK = parseInt(process.env.LCM_CONTEXT_WINDOW_TOKENS || '1000000', 10);
let detectedContextWindow: number | null = null;

export function getContextWindowTokens(): number {
  return detectedContextWindow ?? LCM_CONTEXT_WINDOW_FALLBACK;
}

export function setDetectedContextWindow(value: number): void {
  detectedContextWindow = value;
}

export function getDetectedContextWindow(): number | null {
  return detectedContextWindow;
}

/** @internal - for tests only */
export function _resetDetectedContextWindow(): void {
  detectedContextWindow = null;
}

const LCM_PROACTIVE_COMPACTION_THRESHOLD = parseInt(process.env.LCM_PROACTIVE_COMPACTION_THRESHOLD || '75', 10);
const LCM_SUMMARY_BUDGET_PCT = parseInt(process.env.LCM_SUMMARY_BUDGET_PCT || '25', 10);

// --- Pure functions ---

export function getConversationId(input: { groupFolder: string; chatJid: string }): string {
  return `${input.groupFolder}:${input.chatJid}`;
}

export function shouldProactivelyCompact(lastInputTokens?: number): boolean {
  if (!lastInputTokens) return false;
  if (LCM_PROACTIVE_COMPACTION_THRESHOLD <= 0 || LCM_PROACTIVE_COMPACTION_THRESHOLD >= 100) return false;
  const contextWindow = getContextWindowTokens();
  const usagePct = (lastInputTokens / contextWindow) * 100;
  return usagePct >= LCM_PROACTIVE_COMPACTION_THRESHOLD;
}

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

/**
 * Assemble LCM summary context for injection into system prompt.
 * Returns formatted XML summary blocks, or null if no summaries are available.
 */
export function assembleLcmContext(conversationId: string, dbPath: string): string | null {
  try {
    initLcmDatabase(dbPath);
  } catch {
    return null;
  }

  const allSummaries = getSummariesForConversation(conversationId);
  if (allSummaries.length === 0) return null;

  // Build set of leaf IDs covered by condensed summaries
  const coveredLeafIds = new Set<string>();
  const condensed = allSummaries.filter(s => s.depth > 0);
  for (const cs of condensed) {
    if (cs.child_summary_ids) {
      for (const childId of JSON.parse(cs.child_summary_ids) as string[]) {
        coveredLeafIds.add(childId);
      }
    }
  }

  // Prioritize: condensed (high depth) first, then uncovered leaves
  const uncoveredLeaves = allSummaries.filter(s => s.depth === 0 && !coveredLeafIds.has(s.id));
  const sorted = [
    ...condensed.sort((a, b) => b.depth - a.depth || (a.min_sequence ?? 0) - (b.min_sequence ?? 0)),
    ...uncoveredLeaves.sort((a, b) => (a.min_sequence ?? 0) - (b.min_sequence ?? 0)),
  ];

  // Fit within budget
  const budgetTokens = Math.floor(LCM_SUMMARY_BUDGET_PCT / 100 * getContextWindowTokens());
  let remainingBudget = budgetTokens;
  const selected: typeof sorted = [];

  for (const summary of sorted) {
    const tokens = summary.token_estimate || Math.ceil(summary.content.length / 4);
    if (tokens > remainingBudget) continue;
    selected.push(summary);
    remainingBudget -= tokens;
  }

  if (selected.length === 0) return null;

  // Sort selected by sequence for chronological presentation
  selected.sort((a, b) => (a.min_sequence ?? 0) - (b.min_sequence ?? 0));

  // Format as XML blocks
  const blocks = selected.map(s =>
    `<lcm_summary id="${s.id}" depth="${s.depth}" tokens="${s.token_estimate}" created="${s.created_at}">\n${s.content}\n</lcm_summary>`
  );

  return `## Conversation History (LCM Summaries)

The following are summaries of previous conversation segments that were compacted from this session's history. They are ordered chronologically. You can use the lcm_grep, lcm_describe, and lcm_expand MCP tools to search and drill into specific details.

${blocks.join('\n\n')}`;
}
