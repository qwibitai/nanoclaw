import { CALENDAR_HOLD_BUFFER_MS } from './config.js';
import { getEventsInRange } from './calendar-poller.js';
import { logger } from './logger.js';

export interface CalendarGap {
  start: number;
  end: number;
  durationMs: number;
}

export interface UrgencyInput {
  trustTier: string | null;
  ageMs: number;
  digestCount: number;
  classification: string;
}

export interface DeliverySuggestion {
  action: 'deliver_now' | 'delay' | 'hold';
  deliverAt: number;
  reason: string;
}

const MIN_GAP_MS = 5 * 60 * 1000; // 5 minutes
const MEETING_LOOKAHEAD_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Find free time slots between meetings in the given range.
 */
export function findCalendarGaps(
  rangeStart: number,
  rangeEnd: number,
): CalendarGap[] {
  const events = getEventsInRange(rangeStart, rangeEnd);

  if (events.length === 0) {
    const durationMs = rangeEnd - rangeStart;
    return [{ start: rangeStart, end: rangeEnd, durationMs }];
  }

  // Sort by start time
  const sorted = [...events].sort((a, b) => a.start_time - b.start_time);

  const gaps: CalendarGap[] = [];
  let cursor = rangeStart;

  for (const evt of sorted) {
    const evtStart = Math.max(evt.start_time, rangeStart);
    const evtEnd = Math.min(evt.end_time, rangeEnd);

    if (evtStart > cursor) {
      // There is a gap before this event
      gaps.push({
        start: cursor,
        end: evtStart,
        durationMs: evtStart - cursor,
      });
    }

    // Advance cursor past this event (handle overlaps)
    cursor = Math.max(cursor, evtEnd);
  }

  // Check for gap after last event
  if (cursor < rangeEnd) {
    gaps.push({
      start: cursor,
      end: rangeEnd,
      durationMs: rangeEnd - cursor,
    });
  }

  logger.debug(
    { rangeStart, rangeEnd, gapCount: gaps.length },
    'Computed calendar gaps',
  );

  return gaps;
}

/**
 * Returns true if the user is currently in a meeting at the given time.
 */
export function isInMeeting(now: number): boolean {
  const events = getEventsInRange(now, now + 1);
  return events.length > 0;
}

/**
 * Score an item's urgency from 0 to 1.
 */
export function scoreUrgency(input: UrgencyInput): number {
  let score = 0;

  // Trust tier contribution
  if (input.trustTier === 'escalate') {
    score += 0.5;
  } else if (input.trustTier === 'propose') {
    score += 0.3;
  } else {
    score += 0.1;
  }

  // Classification contribution
  if (input.classification === 'push') {
    score += 0.3;
  } else if (input.classification === 'digest') {
    score += 0.1;
  }

  // Age contribution (up to 0.2)
  const ageHours = input.ageMs / 3_600_000;
  const ageFactor = Math.min(ageHours * 0.05, 0.2);
  score += ageFactor;

  return Math.min(score, 1.0);
}

/**
 * Recommend when to deliver a push notification.
 */
export function suggestDeliveryTime(
  now: number,
  urgencyScore: number,
): DeliverySuggestion {
  // High urgency overrides meeting hold
  if (urgencyScore >= 0.9) {
    logger.debug({ urgencyScore }, 'High urgency — delivering immediately');
    return {
      action: 'deliver_now',
      deliverAt: now,
      reason: 'High urgency overrides meeting hold',
    };
  }

  if (!isInMeeting(now)) {
    return {
      action: 'deliver_now',
      deliverAt: now,
      reason: 'User is not in a meeting',
    };
  }

  // User is in a meeting — find next gap of at least MIN_GAP_MS within 4h
  const lookaheadEnd = now + MEETING_LOOKAHEAD_MS;
  const gaps = findCalendarGaps(now, lookaheadEnd);
  const suitableGap = gaps.find((g) => g.durationMs >= MIN_GAP_MS);

  if (suitableGap) {
    const deliverAt = suitableGap.start + CALENDAR_HOLD_BUFFER_MS;
    logger.debug(
      { gapStart: suitableGap.start, deliverAt },
      'Delaying delivery until next calendar gap',
    );
    return {
      action: 'delay',
      deliverAt,
      reason: `Delivering after meeting ends (gap at ${new Date(suitableGap.start).toISOString()})`,
    };
  }

  // No gap found — deliver at current meeting end + buffer
  const currentMeetingEvents = getEventsInRange(now, now + 1);
  const currentMeetingEnd =
    currentMeetingEvents.length > 0
      ? Math.max(...currentMeetingEvents.map((e) => e.end_time))
      : now;
  const deliverAt = currentMeetingEnd + CALENDAR_HOLD_BUFFER_MS;

  logger.debug(
    { currentMeetingEnd, deliverAt },
    'No gap found — delaying until current meeting ends',
  );

  return {
    action: 'delay',
    deliverAt,
    reason: 'No calendar gap found within lookahead window',
  };
}

/**
 * Returns ms until the next meeting starts within the lookahead window, or null if none.
 */
export function getNextMeetingIn(
  now: number,
  lookAheadMs: number,
): number | null {
  const events = getEventsInRange(now, now + lookAheadMs);
  const futureEvents = events.filter((e) => e.start_time > now);

  if (futureEvents.length === 0) {
    return null;
  }

  const soonest = Math.min(...futureEvents.map((e) => e.start_time));
  return soonest - now;
}
