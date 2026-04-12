import { NewMessage } from './types.js';

export type PendingInputSource = 'system' | 'user';
export type PendingInputKind = 'system' | 'command' | 'workflow_reply' | 'chat';

export interface PendingInput {
  source: PendingInputSource;
  kind: PendingInputKind;
}

export interface PendingInputClassification extends PendingInput {
  confidence: number;
  reason: string;
  classifier: 'heuristic' | 'ai';
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

const IMPERATIVE_FOLLOW_UP_PATTERNS = [
  /^(?:filter|mark|remove|delete|drop|keep|set|update|change|move|skip|pick|select|choose|sort|group|rerank|rerun|retry|process|research|analyze|review|investigate|continue)\b/i,
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
): PendingInputClassification {
  const text = message.content.trim();
  if (!text) {
    return {
      source: 'user',
      kind: 'chat',
      confidence: 0.2,
      reason: 'empty message',
      classifier: 'heuristic',
    };
  }

  if (DIRECT_COMMAND_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      source: 'user',
      kind: 'command',
      confidence: 0.99,
      reason: 'matched explicit command pattern',
      classifier: 'heuristic',
    };
  }

  if (WORKFLOW_REPLY_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      source: 'user',
      kind: 'workflow_reply',
      confidence: 0.98,
      reason: 'matched workflow decision pattern',
      classifier: 'heuristic',
    };
  }

  if (
    isReplyToAssistant(message, assistantName) &&
    ASSISTANT_REPLY_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return {
      source: 'user',
      kind: 'workflow_reply',
      confidence: 0.94,
      reason: 'short reply to assistant matched workflow reply pattern',
      classifier: 'heuristic',
    };
  }

  if (isLowSignalChat(text)) {
    return {
      source: 'user',
      kind: 'chat',
      confidence: 0.97,
      reason: 'matched low-signal chat pattern',
      classifier: 'heuristic',
    };
  }

  if (
    SUBSTANTIVE_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(text)) ||
    IMPERATIVE_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(text)) ||
    text.includes('?')
  ) {
    return {
      source: 'user',
      kind: 'workflow_reply',
      confidence: 0.84,
      reason: 'matched substantive follow-up pattern',
      classifier: 'heuristic',
    };
  }

  if (
    isReplyToAssistant(message, assistantName) &&
    text.split(/\s+/).length >= 2
  ) {
    return {
      source: 'user',
      kind: 'workflow_reply',
      confidence: 0.82,
      reason: 'non-trivial reply to assistant',
      classifier: 'heuristic',
    };
  }

  return {
    source: 'user',
    kind: 'chat',
    confidence: 0.32,
    reason: 'no actionable pattern matched',
    classifier: 'heuristic',
  };
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
  const { source, kind } = classifyPendingInputDetailed(messages, assistantName);
  return { source, kind };
}

export function classifyPendingInputDetailed(
  messages: NewMessage[],
  assistantName: string,
): PendingInputClassification {
  let bestKind: PendingInputKind = 'chat';
  let bestClassification: PendingInputClassification = {
    source: 'user',
    kind: 'chat',
    confidence: 0.2,
    reason: 'no messages to classify',
    classifier: 'heuristic',
  };

  for (const message of messages) {
    const classification = classifyMessageKind(message, assistantName);
    const kind = classification.kind;
    if (
      kindPriority(kind) > kindPriority(bestKind) ||
      (kindPriority(kind) === kindPriority(bestKind) &&
        classification.confidence > bestClassification.confidence)
    ) {
      bestKind = kind;
      bestClassification = classification;
    }
  }

  return bestClassification;
}

export function createSystemPendingInput(): PendingInput {
  return { source: 'system', kind: 'system' };
}
