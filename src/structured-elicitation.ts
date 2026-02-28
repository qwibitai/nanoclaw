/**
 * Structured Elicitation for Sovereign
 * Present options to users in Discord/Slack instead of free-text-only.
 * Pure types and formatting — no I/O.
 */

export interface ElicitationRequest {
  id: string;
  question: string;
  options: string[];
  allowFreetext: boolean;
  timeoutSeconds: number;
  sourceGroup: string;
  sourceChatJid: string;
  timestamp: string;
}

export interface ElicitationResponse {
  id: string;
  chosen: string | null;
  freetext: string | null;
  timeout: boolean;
  timestamp: string;
}

const NUMBER_EMOJIS = [
  '1️⃣',
  '2️⃣',
  '3️⃣',
  '4️⃣',
  '5️⃣',
  '6️⃣',
  '7️⃣',
  '8️⃣',
  '9️⃣',
  '🔟',
];

/**
 * Format a question with numbered options for display in chat.
 */
export function formatQuestion(
  question: string,
  options: string[],
  allowFreetext: boolean,
): string {
  const lines = [question, ''];
  for (let i = 0; i < options.length; i++) {
    const emoji = NUMBER_EMOJIS[i] || `${i + 1}.`;
    lines.push(`${emoji} ${options[i]}`);
  }
  if (allowFreetext) {
    lines.push('', '_Or type a custom response._');
  }
  return lines.join('\n');
}

/**
 * Get the emoji for a given option index (0-based).
 */
export function getOptionEmoji(index: number): string {
  return NUMBER_EMOJIS[index] || `${index + 1}`;
}

/**
 * Get all reaction emojis needed for the options.
 */
export function getReactionEmojis(optionCount: number): string[] {
  return NUMBER_EMOJIS.slice(0, Math.min(optionCount, NUMBER_EMOJIS.length));
}

/**
 * Map a reaction emoji back to the chosen option text.
 * Returns null if the emoji doesn't match any option.
 */
export function resolveReaction(
  emoji: string,
  options: string[],
): string | null {
  const index = NUMBER_EMOJIS.indexOf(emoji);
  if (index >= 0 && index < options.length) {
    return options[index];
  }
  return null;
}

/**
 * Parse a text reply as an option selection.
 * Matches "1", "2", etc. or the exact option text.
 * Returns null if no match (treat as freetext).
 */
export function parseTextReply(text: string, options: string[]): string | null {
  const trimmed = text.trim();

  // Try numeric match ("1", "2", etc.)
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1];
  }

  // Try exact match (case-insensitive)
  const match = options.find((o) => o.toLowerCase() === trimmed.toLowerCase());
  if (match) return match;

  return null;
}

/**
 * Build a response object.
 */
export function buildResponse(
  requestId: string,
  chosen: string | null,
  freetext: string | null,
  timeout: boolean,
): ElicitationResponse {
  return {
    id: requestId,
    chosen,
    freetext,
    timeout,
    timestamp: new Date().toISOString(),
  };
}
