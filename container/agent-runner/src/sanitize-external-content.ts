/**
 * Sanitizes external web content (WebFetch/WebSearch results) before they reach
 * the model, protecting against content injection attacks.
 *
 * Background: Anthropic ships a test string — analogous to the EICAR antivirus
 * test file — that causes Claude to immediately halt when processed as input.
 * This string can be embedded in any web page, GitHub README, or other content
 * that an agent fetches. When the agent reads that content, its session terminates.
 *
 * Real-world incident: A Wikipedia editor placed this string on an agent's talk
 * page. Every run of the agent that fetched that page died silently. The attack
 * is publicly documented: https://pivot-to-ai.com/2026/02/11/the-anthropic-test-refusal-string-kill-a-claude-session-dead/
 *
 * This module implements a PostToolUse hook that filters configured strings from
 * WebFetch and WebSearch results before they are added to the model's context.
 *
 * Configuration:
 *   Set NANOCLAW_EXTERNAL_CONTENT_FILTER to the string(s) to filter.
 *   Separate multiple strings with a pipe character (|).
 *   Example: NANOCLAW_EXTERNAL_CONTENT_FILTER="string1|string2"
 *
 * See: https://github.com/qwibitai/nanoclaw/issues/842
 */

import { HookCallback } from '@anthropic-ai/claude-agent-sdk';

// The tool result type from PostToolUse hook input.
// Using unknown here because the SDK type may vary; we handle string results only.
interface PostToolUseInput {
  tool_name?: string;
  tool_result?: unknown;
}

const REPLACEMENT = '[FILTERED_EXTERNAL_CONTENT]';

/**
 * Load filter strings from the NANOCLAW_EXTERNAL_CONTENT_FILTER environment variable.
 * Returns an empty array if the variable is not set or empty.
 */
function loadFilterStrings(): string[] {
  const raw = process.env.NANOCLAW_EXTERNAL_CONTENT_FILTER ?? '';
  return raw ? raw.split('|').filter((s) => s.length > 0) : [];
}

/**
 * Apply all configured filter strings to the given text, replacing each
 * occurrence with a safe placeholder.
 */
function applyFilters(text: string, filterStrings: string[]): { result: string; filtered: boolean } {
  let result = text;
  let filtered = false;
  for (const filterString of filterStrings) {
    if (result.includes(filterString)) {
      result = result.split(filterString).join(REPLACEMENT);
      filtered = true;
    }
  }
  return { result, filtered };
}

/**
 * Creates a PostToolUse hook that sanitizes WebFetch and WebSearch results.
 * Strings matching NANOCLAW_EXTERNAL_CONTENT_FILTER are replaced before
 * the result is added to the model context.
 *
 * Returns a no-op if no filter strings are configured.
 */
export function createSanitizeWebContentHook(): HookCallback {
  const filterStrings = loadFilterStrings();

  if (filterStrings.length === 0) {
    // No-op: return identity hook when no filters configured.
    return async () => ({});
  }

  return async (input) => {
    const postInput = input as unknown as PostToolUseInput;
    const toolResult = postInput.tool_result;

    // Only process string results (WebFetch returns text content as a string).
    if (typeof toolResult !== 'string') return {};

    const { result, filtered } = applyFilters(toolResult, filterStrings);
    if (!filtered) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedOutput: result,
      },
    };
  };
}
