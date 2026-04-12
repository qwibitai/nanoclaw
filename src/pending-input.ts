import { NewMessage } from './types.js';

export type PendingInputSource = 'system' | 'user';
export type PendingInputKind = 'system' | 'command' | 'workflow_reply' | 'chat';

export interface PendingInput {
  source: PendingInputSource;
  kind: PendingInputKind;
}

const DIRECT_COMMAND_PATTERNS = [
  /^\/[\w-]+(?:\s|$)/i,
  /^run\s+\/[\w-]+(?:\s|$)/i,
  /^tsx\s+\S+/i,
  /^pipeline\s+status$/i,
  /^show\s+(?:pending(?:\s+research\s+runs?)?|opportunities|status|tasks)\b/i,
  /^list\s+(?:tasks|runs|opportunities|groups)\b/i,
  /^top\s+\d+\b/i,
];

const WORKFLOW_REPLY_PATTERNS = [
  /^(?:approve|reject)\s+(?:run\s+)?(?:\d+(?:[\s,]+\d+)*|all|none|first|second|third|last)$/i,
];

const ASSISTANT_REPLY_PATTERNS = [
  /^\d+(?:[\s,]+\d+)*$/,
  /^(?:yes|no|go|do it|all|none|first|second|third|last)$/i,
];

const LOW_SIGNAL_CHAT_PATTERNS = [
  /^(?:ok|okay|kk|k|thanks?|thank you|thx|got it|sounds good|cool|great|nice|perfect|understood|makes sense|sure|fine|alright|roger)(?:[!.,\s]*)$/i,
  /^(?:👍|👌|🙏|👏|✅|🔥|🙂|😊|😄|😂|❤️|❤)+$/u,
];

const SUBSTANTIVE_FOLLOW_UP_PATTERNS = [
  /^(?:what|how|why|which|when|where|who|whom|whose|can|could|would|should|is|are|do|does|did|will|have|has|had|tell|show|list|give|explain|describe|summarize|check|compare|find|look|inspect|continue|expand)\b/i,
];

function normalizeName(name?: string | null): string {
  return (name ?? '').trim().replace(/^@/, '').toLowerCase();
}

function isLowSignalChat(text: string): boolean {
  return LOW_SIGNAL_CHAT_PATTERNS.some((pattern) => pattern.test(text));
}

function isReplyToAssistant(
  message: NewMessage,
  assistantName: string,
): boolean {
  if (!message.reply_to_message_id) return false;
  const replySender = normalizeName(message.reply_to_sender_name);
  const assistant = normalizeName(assistantName);
  return replySender.length > 0 && replySender === assistant;
}

function classifyMessageKind(
  message: NewMessage,
  assistantName: string,
): PendingInputKind {
  const text = message.content.trim();
  if (!text) return 'chat';

  if (DIRECT_COMMAND_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'command';
  }

  if (WORKFLOW_REPLY_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'workflow_reply';
  }

  if (
    isReplyToAssistant(message, assistantName) &&
    ASSISTANT_REPLY_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return 'workflow_reply';
  }

  if (isLowSignalChat(text)) {
    return 'chat';
  }

  if (
    SUBSTANTIVE_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(text)) ||
    text.includes('?')
  ) {
    return 'workflow_reply';
  }

  if (isReplyToAssistant(message, assistantName) && text.split(/\s+/).length >= 2) {
    return 'workflow_reply';
  }

  return 'chat';
}

function kindPriority(kind: PendingInputKind): number {
  switch (kind) {
    case 'command':
      return 3;
    case 'workflow_reply':
      return 2;
    case 'chat':
      return 1;
    case 'system':
      return 0;
  }
}

export function classifyPendingInput(
  messages: NewMessage[],
  assistantName: string,
): PendingInput {
  let bestKind: PendingInputKind = 'chat';

  for (const message of messages) {
    const kind = classifyMessageKind(message, assistantName);
    if (kindPriority(kind) > kindPriority(bestKind)) {
      bestKind = kind;
    }
  }

  return { source: 'user', kind: bestKind };
}

export function createSystemPendingInput(): PendingInput {
  return { source: 'system', kind: 'system' };
}
