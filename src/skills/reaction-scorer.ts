/**
 * Reaction Scorer
 * Maps emoji reactions on bot messages to evaluation scores,
 * providing a direct user feedback signal for the behavioral skills system.
 */
import {
  getRecentUnevaluatedRun,
  getSkillSelectionsForRun,
  isBotMessage,
  recordEvaluation,
  updateSkillPerformance,
} from '../db.js';
import { logger } from '../logger.js';

/**
 * Emoji-to-score mapping.
 * Positive reactions score high, negative reactions score low.
 * Unrecognized emoji defaults to a mild positive (0.6) since reacting
 * at all suggests engagement.
 */
const EMOJI_SCORES: Record<string, number> = {
  // Strong positive
  '❤️': 1.0,
  '🔥': 1.0,
  '💯': 1.0,
  '🎉': 0.95,
  '🙏': 0.9,
  '⭐': 0.9,
  '✨': 0.9,

  // Positive
  '👍': 0.8,
  '👏': 0.8,
  '💪': 0.8,
  '✅': 0.8,
  '🤩': 0.85,

  // Mild positive
  '😊': 0.7,
  '🙂': 0.7,
  '👌': 0.7,
  '💡': 0.7,

  // Neutral / acknowledgment
  '👀': 0.5,
  '🤔': 0.5,
  '😐': 0.5,

  // Negative
  '😕': 0.3,
  '😒': 0.3,
  '🙄': 0.25,

  // Strong negative
  '👎': 0.1,
  '❌': 0.1,
  '😡': 0.05,
  '🤦': 0.15,
  '💩': 0.0,
};

const DEFAULT_SCORE = 0.6;

export function emojiToScore(emoji: string): number {
  return EMOJI_SCORES[emoji] ?? DEFAULT_SCORE;
}

/**
 * Handle a reaction on a message in a registered group.
 * If the message is a bot message and there's a recent unevaluated task run
 * for that chat, record the reaction as a user_reaction evaluation.
 *
 * Called from index.ts when the WhatsApp channel reports a reaction.
 */
export function handleReactionFeedback(
  messageId: string,
  chatJid: string,
  emoji: string,
): void {
  // Ignore reaction removals (empty emoji)
  if (!emoji) return;

  // Only score reactions on bot messages
  if (!isBotMessage(messageId, chatJid)) return;

  // Find the most recent unevaluated task run for this chat
  const run = getRecentUnevaluatedRun(chatJid);
  if (!run) {
    logger.debug(
      { chatJid, messageId },
      'Reaction on bot message but no unevaluated run found',
    );
    return;
  }

  const score = emojiToScore(emoji);
  const evalId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  recordEvaluation({
    id: evalId,
    run_id: run.id,
    score,
    dimensions: null,
    evaluation_source: 'user_reaction',
    evaluator_reasoning: null,
    raw_feedback: JSON.stringify({ emoji, messageId }),
    evaluated_at: new Date().toISOString(),
  });

  // Update performance for each skill used in this run
  const skillIds = getSkillSelectionsForRun(run.id);
  for (const skillId of skillIds) {
    updateSkillPerformance(skillId);
  }

  logger.info(
    { chatJid, emoji, score, runId: run.id, evalId },
    'User reaction recorded as skill evaluation',
  );
}
