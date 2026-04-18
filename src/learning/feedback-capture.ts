import { logger } from '../logger.js';
import { addRule } from './rules-engine.js';
import { inferActionClasses } from './outcome-enricher.js';

export const CORRECTION_KEYWORDS = [
  'wrong',
  "don't",
  'stop',
  'instead',
  'not that',
  "shouldn't",
  'bad',
  'incorrect',
  'no,',
  'no.',
];

export const POSITIVE_KEYWORDS = [
  'perfect',
  'exactly',
  'great',
  'keep doing',
  'that worked',
];

export interface DetectedFeedback {
  type: 'correction' | 'positive';
  text: string;
}

const TWO_MINUTES_MS = 2 * 60 * 1000;

export function detectFeedback(
  message: string,
  lastBotTimestamp: number,
  groupId: string,
): DetectedFeedback | null {
  if (!lastBotTimestamp) return null;

  const age = Date.now() - lastBotTimestamp;
  if (age > TWO_MINUTES_MS) return null;

  const lower = message.toLowerCase();

  for (const kw of CORRECTION_KEYWORDS) {
    if (lower.includes(kw)) {
      logger.debug({ groupId, keyword: kw }, 'Correction feedback detected');
      return { type: 'correction', text: message };
    }
  }

  for (const kw of POSITIVE_KEYWORDS) {
    if (lower.includes(kw)) {
      logger.debug({ groupId, keyword: kw }, 'Positive feedback detected');
      return { type: 'positive', text: message };
    }
  }

  return null;
}

export function saveFeedbackAsRule(
  feedback: DetectedFeedback,
  groupId: string,
): string {
  const actionClasses = inferActionClasses(feedback.text);

  const id = addRule({
    rule: feedback.text,
    source: 'user_feedback',
    actionClasses: actionClasses.length > 0 ? actionClasses : ['general'],
    groupId,
    confidence: 0.9,
    evidenceCount: 1,
  });

  logger.info({ id, groupId }, 'Feedback saved as rule');
  return id;
}
