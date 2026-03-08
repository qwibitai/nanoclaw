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
 * This module implements a PostToolUse hook that matches and redacts known
 * dangerous patterns from WebFetch and WebSearch results before they are added
 * to the model's context.
 *
 * See: https://github.com/qwibitai/nanoclaw/issues/842
 */

import { HookCallback } from '@anthropic-ai/claude-agent-sdk';

// The tool result type from PostToolUse hook input.
interface PostToolUseInput {
  tool_name?: string;
  tool_result?: unknown;
}

const REDACTED = '[FILTERED_EXTERNAL_CONTENT]';

/**
 * Patterns that match content known to cause Claude session termination
 * when processed as model input.
 *
 * The Anthropic test refusal string has a distinctive structure that can be
 * matched by pattern without hardcoding the literal string. The pattern below
 * matches the known format: a specific token followed by uppercase hex/alphanumeric
 * characters used as a unique identifier.
 *
 * See: https://pivot-to-ai.com/2026/02/11/the-anthropic-test-refusal-string-kill-a-claude-session-dead/
 */
const DANGEROUS_CONTENT_PATTERNS: RegExp[] = [
  /ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL[_A-Z0-9]*/g,
];

/**
 * Applies all dangerous content patterns to the given text,
 * replacing matches with a safe placeholder.
 */
function sanitize(text: string): { result: string; filtered: boolean } {
  let result = text;
  let filtered = false;
  for (const pattern of DANGEROUS_CONTENT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, REDACTED);
      filtered = true;
    }
  }
  return { result, filtered };
}

/**
 * Creates a PostToolUse hook that sanitizes WebFetch and WebSearch results.
 * Content matching known dangerous patterns is redacted before the result
 * is added to the model context. Active by default — no configuration required.
 */
export function createSanitizeWebContentHook(): HookCallback {
  return async (input) => {
    const postInput = input as unknown as PostToolUseInput;
    const toolResult = postInput.tool_result;

    // Only process string results (WebFetch returns text content as a string).
    if (typeof toolResult !== 'string') return {};

    const { result, filtered } = sanitize(toolResult);
    if (!filtered) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedOutput: result,
      },
    };
  };
}
