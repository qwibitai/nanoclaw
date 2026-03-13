import { HookCallback } from '@anthropic-ai/claude-agent-sdk';

interface PostToolUseInput {
  tool_name?: string;
  tool_result?: unknown;
}

const REDACTED = '[REDACTED_REFUSAL_STRING]';

const DANGEROUS_CONTENT_PATTERNS: RegExp[] = [
  /ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL[_A-Z0-9]*/g,
];

function sanitize(text: string): { result: string; filtered: boolean } {
  let filtered = false;
  let result = text;
  for (const pattern of DANGEROUS_CONTENT_PATTERNS) {
    const before = result;
    result = result.replace(pattern, REDACTED);
    if (result !== before) filtered = true;
  }
  return { result, filtered };
}

function sanitizeValue(value: unknown): { result: unknown; filtered: boolean } {
  if (typeof value === 'string') {
    return sanitize(value);
  }
  if (Array.isArray(value)) {
    let filtered = false;
    const result = value.map(item => {
      const s = sanitizeValue(item);
      if (s.filtered) filtered = true;
      return s.result;
    });
    return { result, filtered };
  }
  if (value && typeof value === 'object') {
    let filtered = false;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = sanitizeValue(v);
      if (s.filtered) filtered = true;
      result[k] = s.result;
    }
    return { result, filtered };
  }
  return { result: value, filtered: false };
}

export function createSanitizeWebContentHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const postInput = input as PostToolUseInput;
    const toolResult = postInput.tool_result;

    if (!toolResult) return {};

    const { result: sanitized, filtered } = sanitizeValue(toolResult);

    if (!filtered) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedOutput: sanitized,
      },
    };
  };
}
