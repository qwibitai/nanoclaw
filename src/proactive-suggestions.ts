import { getTrackedItemsByState } from './tracked-items.js';
import {
  isInMeeting,
  findCalendarGaps,
  scoreUrgency,
} from './scheduling-advisor.js';
import { logger } from './logger.js';

export interface SchedulingSuggestion {
  message: string;
  pendingCount: number;
  nextGapAt: number | null;
  urgencyScore: number;
}

const LOOKAHEAD_MS = 4 * 60 * 60 * 1000;
const MIN_GAP_MS = 5 * 60 * 1000;

export function generateSuggestion(
  groupName: string,
  now: number,
): SchedulingSuggestion | null {
  const pending = getTrackedItemsByState(groupName, ['pending']);
  const pushItems = pending.filter((i) => i.classification === 'push');

  if (pushItems.length === 0) {
    return null;
  }

  if (!isInMeeting(now)) {
    return null;
  }

  const maxUrgency = Math.max(
    ...pushItems.map((item) =>
      scoreUrgency({
        trustTier: item.trust_tier,
        ageMs: now - item.detected_at,
        digestCount: item.digest_count,
        classification: item.classification ?? 'push',
      }),
    ),
  );

  const gaps = findCalendarGaps(now, now + LOOKAHEAD_MS);
  const suitableGap = gaps.find((g) => g.durationMs >= MIN_GAP_MS);
  const nextGapAt = suitableGap?.start ?? null;

  let message: string;
  if (maxUrgency >= 0.8) {
    const urgentTitles = pushItems
      .filter((i) => i.trust_tier === 'escalate')
      .map((i) => i.title)
      .slice(0, 3);
    message = `⚡ ${pushItems.length} action-required item(s) pending during your meeting`;
    if (urgentTitles.length > 0) {
      message += `: ${urgentTitles.join(', ')}`;
    }
    if (nextGapAt) {
      const minsUntilGap = Math.round((nextGapAt - now) / 60000);
      message += `. Next gap in ~${minsUntilGap}min`;
    }
  } else if (nextGapAt) {
    const minsUntilGap = Math.round((nextGapAt - now) / 60000);
    message = `📋 ${pushItems.length} pending item(s) held during meeting. Next gap in ~${minsUntilGap}min — want me to hold until then?`;
  } else {
    message = `📋 ${pushItems.length} pending item(s) held. No calendar gaps in the next 4 hours.`;
  }

  logger.debug(
    { groupName, pendingCount: pushItems.length, maxUrgency, nextGapAt },
    'Generated proactive suggestion',
  );

  return {
    message,
    pendingCount: pushItems.length,
    nextGapAt,
    urgencyScore: maxUrgency,
  };
}
