import { NewMessage } from './types.js';
import {
  estimateTokenCount,
  MODEL_CONTEXT_LIMIT,
  MODEL_CONTEXT_LIMITS,
  TOKEN_WARNING_THRESHOLD,
  TOKEN_AUTO_TRIM_PERCENT,
  TOKEN_MAX_MESSAGES,
  ACTIVE_MODEL,
} from './config.js';

export interface TokenInfo {
  totalTokens: number;
  tokenLimit: number;
  usagePercent: number;
  isWarning: boolean;
  isOverLimit: boolean;
  messagesCount: number;
  trimmedCount: number; // How many messages were removed
}

/**
 * Format messages and estimate token count for the resulting XML
 */
export function calculatePromptTokens(messages: NewMessage[], timezone: string): number {
  if (messages.length === 0) return 0;

  // Build the prompt same way formatMessages does
  const lines = messages.map((m) => {
    const displayTime = new Date(m.timestamp).toLocaleString('en-US', {
      timeZone: timezone,
      hour12: true,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const escapedContent = escapeXml(m.content);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapedContent}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;
  const fullPrompt = `${header}<messages>\n${lines.join('\n')}\n</messages>`;

  return estimateTokenCount(fullPrompt);
}

/**
 * Escape XML special characters
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Check if token limit is exceeded and handle auto-trimming
 *
 * Strategy: Always keep the most recent messages that fit within the warning threshold,
 * or up to TOKEN_MAX_MESSAGES. If auto-trim is enabled and we're over the warning
 * threshold, trim the oldest messages proportionally.
 *
 * @returns TokenInfo with statistics and the trimmed message list
 */
export function trimMessagesForTokenLimit(
  messages: NewMessage[],
  timezone: string,
  autoTrim: boolean = TOKEN_AUTO_TRIM_PERCENT > 0
): { trimmed: NewMessage[]; tokenInfo: TokenInfo } {
  if (messages.length === 0) {
    return { trimmed: [], tokenInfo: { totalTokens: 0, tokenLimit: MODEL_CONTEXT_LIMIT, usagePercent: 0, isWarning: false, isOverLimit: false, messagesCount: 0, trimmedCount: 0 } };
  }

  // Calculate tokens for full set
  const fullTokenCount = calculatePromptTokens(messages, timezone);
  const warningThreshold = Math.floor(MODEL_CONTEXT_LIMIT * TOKEN_WARNING_THRESHOLD);

  const tokenInfo: TokenInfo = {
    totalTokens: fullTokenCount,
    tokenLimit: MODEL_CONTEXT_LIMIT,
    usagePercent: (fullTokenCount / MODEL_CONTEXT_LIMIT) * 100,
    isWarning: fullTokenCount >= warningThreshold,
    isOverLimit: fullTokenCount > MODEL_CONTEXT_LIMIT,
    messagesCount: messages.length,
    trimmedCount: 0,
  };

  // If under warning threshold, return all messages
  if (fullTokenCount < warningThreshold && messages.length <= TOKEN_MAX_MESSAGES) {
    return { trimmed: messages, tokenInfo };
  }

  // Start with all messages in reverse order (newest first)
  let keepMessages: NewMessage[] = [...messages].reverse();
  let trimmedCount = messages.length - keepMessages.length;

  // Apply hard message count limit first (keep only TOKEN_MAX_MESSAGES newest)
  if (keepMessages.length > TOKEN_MAX_MESSAGES) {
    keepMessages = keepMessages.slice(0, TOKEN_MAX_MESSAGES);
    trimmedCount += messages.length - keepMessages.length - trimmedCount;
  }

  // If over warning threshold and auto-trim is enabled, trim oldest until under warning
  let currentTokenCount = calculatePromptTokens(keepMessages.reverse(), timezone);
  while (
    currentTokenCount > warningThreshold &&
    keepMessages.length > 1 &&
    autoTrim &&
    tokenInfo.isOverLimit
  ) {
    // Remove oldest message (beginning of array after reverse)
    keepMessages.shift();
    trimmedCount++;
    currentTokenCount = calculatePromptTokens(keepMessages, timezone);
  }

  // Final reversal to restore chronological order (oldest first as required by formatMessages)
  const finalTrimmed = keepMessages.reverse();

  return {
    trimmed: finalTrimmed,
    tokenInfo: {
      ...tokenInfo,
      totalTokens: currentTokenCount,
      messagesCount: finalTrimmed.length,
      trimmedCount,
    },
  };
}

/**
 * Create a compact summary of old conversation to preserve context
 * This is a placeholder - the actual compacting would be done by the agent
 * or via a dedicated summarization task.
 */
export function createCompactionPrompt(oldestMessages: NewMessage[]): string {
  if (oldestMessages.length === 0) return '';

  const messagesByDate = new Map<string, NewMessage[]>();
  for (const msg of oldestMessages) {
    const date = new Date(msg.timestamp).toLocaleDateString();
    const existing = messagesByDate.get(date) || [];
    existing.push(msg);
    messagesByDate.set(date, existing);
  }

  const lines: string[] = [
    'Create a concise summary of this conversation thread. Include:',
    '- Key decisions and agreements',
    '- Important context the user provided about themselves or the task',
    '- Current status or next steps',
    '- Any ongoing issues or unresolved questions',
    '',
    'Format: 2-3 paragraphs maximum. Do not include timestamps or exact quotes.',
    '',
    'Messages:',
  ];

  for (const [date, msgs] of messagesByDate) {
    lines.push(`\n--- ${date} ---`);
    for (const msg of msgs) {
      const when = new Date(msg.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      const sender = msg.is_from_me ? 'Isaac' : msg.sender_name;
      lines.push(`[${when}] ${sender}: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * Check token configuration and log warnings if misconfigured
 * Should be called once daily or when model changes
 */
export function validateTokenConfig(): void {
  const baseModel = getBaseModelName(ACTIVE_MODEL);

  if (!MODEL_CONTEXT_LIMITS[baseModel]) {
    console.warn(
      `[Token Manager] Unknown model: ${ACTIVE_MODEL} (base: ${baseModel}). ` +
      `Using default limit of ${MODEL_CONTEXT_LIMIT} tokens. ` +
      `Add to MODEL_CONTEXT_LIMITS in config.ts if this is a known model.`
    );
    return; // Skip further checks if model not in map
  }

  const recommendedLimit = MODEL_CONTEXT_LIMITS[baseModel];
  if (MODEL_CONTEXT_LIMIT !== recommendedLimit) {
    console.warn(
      `[Token Manager] Using ${MODEL_CONTEXT_LIMIT} token limit, but ${baseModel} ` +
      `officially supports ${recommendedLimit}. Update TOKEN_WARNING_THRESHOLD if needed.`
    );
  }

  // Check if auto-trim is too aggressive
  if (TOKEN_AUTO_TRIM_PERCENT >= 50) {
    console.warn(
      '[Token Manager] TOKEN_AUTO_TRIM_PERCENT is >= 50%, which may remove too much history. ' +
      'Consider 10-20% for safety.'
    );
  }

  // Validate that warning threshold is reasonable
  if (TOKEN_WARNING_THRESHOLD > 0.95) {
    console.warn(
      '[Token Manager] TOKEN_WARNING_THRESHOLD is very high (>95%). ' +
      'Set to 0.8 to trigger warnings at 80% usage for safety.'
    );
  }
}

/**
 * Parse model name helper (used in config)
 */
function getBaseModelName(model: string): string {
  const cleanModel = model.split(':')[0];
  if (cleanModel.includes('/')) {
    return cleanModel.split('/')[1];
  }
  return cleanModel;
}
