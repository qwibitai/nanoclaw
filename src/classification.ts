import { CHAT_INTERFACE_CONFIG } from './config.js';
import { getAdjustment } from './classification-adjustments.js';
import type {
  ClassificationReason,
  ItemClassification,
} from './tracked-items.js';

export interface ClassificationInput {
  source: string;
  sourceId: string;
  superpilotLabel: string | null;
  trustTier: string | null;
  senderPattern: string;
  title: string;
  summary: string | null;
  userActed: boolean;
  metadata: Record<string, unknown>;
}

export interface ClassificationResult {
  decision: ItemClassification;
  reason: ClassificationReason;
}

export function classify(input: ClassificationInput): ClassificationResult {
  const { urgencyKeywords, vipList } = CHAT_INTERFACE_CONFIG;

  if (input.userActed) {
    return { decision: 'resolved', reason: { final: 'resolved' } };
  }

  let result: ClassificationResult;

  if (input.source === 'gmail' && input.superpilotLabel) {
    result = classifyEmail(input);
  } else if (input.source === 'calendar') {
    result = classifyCalendar(input);
  } else if (input.source === 'discord') {
    result = classifyDiscord(input, vipList);
  } else if (hasUrgencyKeyword(input.title, urgencyKeywords)) {
    result = { decision: 'push', reason: { final: 'push' } };
  } else {
    result = { decision: 'digest', reason: { final: 'digest' } };
  }

  return applyLearningAdjustment(input, result);
}

function classifyEmail(input: ClassificationInput): ClassificationResult {
  const reason: ClassificationReason = {
    superpilot: input.superpilotLabel ?? undefined,
    trust: input.trustTier ?? undefined,
    final: 'digest',
  };

  if (input.superpilotLabel === 'needs-attention') {
    reason.final = 'push';
    return { decision: 'push', reason };
  }

  if (
    input.superpilotLabel === 'fyi' ||
    input.superpilotLabel === 'newsletter' ||
    input.superpilotLabel === 'transactional'
  ) {
    reason.final = 'digest';
    return { decision: 'digest', reason };
  }

  if (hasUrgencyKeyword(input.title, CHAT_INTERFACE_CONFIG.urgencyKeywords)) {
    reason.final = 'push';
    return { decision: 'push', reason };
  }

  return { decision: 'digest', reason };
}

function classifyCalendar(input: ClassificationInput): ClassificationResult {
  const conflictInMinutes = input.metadata.conflictInMinutes as
    | number
    | undefined;
  if (conflictInMinutes !== undefined && conflictInMinutes <= 30) {
    return {
      decision: 'push',
      reason: {
        calendar: `conflict_in_${conflictInMinutes}min`,
        final: 'push',
      },
    };
  }
  return {
    decision: 'digest',
    reason: {
      calendar: conflictInMinutes
        ? `conflict_in_${conflictInMinutes}min`
        : 'no_conflict',
      final: 'digest',
    },
  };
}

function classifyDiscord(
  input: ClassificationInput,
  vipList: string[],
): ClassificationResult {
  const isMention = input.metadata.isMention as boolean | undefined;
  const isVip = vipList.some((v) =>
    input.senderPattern.toLowerCase().includes(v.toLowerCase()),
  );

  if (isMention && isVip) {
    return {
      decision: 'push',
      reason: { final: 'push' },
    };
  }
  return {
    decision: 'digest',
    reason: { final: 'digest' },
  };
}

function hasUrgencyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function applyLearningAdjustment(
  input: ClassificationInput,
  result: ClassificationResult,
): ClassificationResult {
  try {
    const adjustment = getAdjustment(input.source, input.senderPattern);
    if (adjustment === 'none') {
      result.reason.learning = 'no_adjustment';
      return result;
    }

    result.reason.learning = adjustment;

    if (adjustment === 'demote' && result.decision === 'push') {
      return {
        decision: 'digest',
        reason: { ...result.reason, learning: 'demote', final: 'digest' },
      };
    }
    if (adjustment === 'promote' && result.decision === 'digest') {
      return {
        decision: 'push',
        reason: { ...result.reason, learning: 'promote', final: 'push' },
      };
    }
  } catch {
    result.reason.learning = 'error';
  }

  return result;
}
