import { getEventsInRange } from '../calendar-poller.js';
import { logger } from '../logger.js';

// --- Interfaces ---

export interface BriefingRequest {
  eventId: string;
  eventTitle: string;
  startsAt: number;
  attendees: string[];
  prompt: string;
}

// --- In-memory dedup set ---

const briefedEventIds = new Set<string>();

/**
 * Reset the dedup set. Useful for tests and process restart scenarios.
 */
export function resetBriefingState(): void {
  briefedEventIds.clear();
}

/**
 * Returns BriefingRequest objects for meetings starting within the next
 * `minutesBefore` minutes from `now`.
 *
 * Skips:
 * - Events that have already started (start_time <= now)
 * - Events already briefed this session (deduped by event ID)
 */
export function getMeetingBriefings(
  now: number,
  minutesBefore: number,
): BriefingRequest[] {
  const windowStart = now;
  const windowEnd = now + minutesBefore * 60_000;

  const events = getEventsInRange(windowStart, windowEnd);

  const briefings: BriefingRequest[] = [];

  for (const event of events) {
    // Skip events that have already started
    if (event.start_time <= now) {
      logger.debug(
        { eventId: event.id, start_time: event.start_time, now },
        'Meeting briefing: skipping already-started event',
      );
      continue;
    }

    // Skip already briefed events
    if (briefedEventIds.has(event.id)) {
      logger.debug(
        { eventId: event.id },
        'Meeting briefing: skipping already-briefed event',
      );
      continue;
    }

    briefedEventIds.add(event.id);

    const attendeeList =
      event.attendees.length > 0 ? event.attendees.join(', ') : 'None listed';
    const locationLine =
      event.location != null ? `Location: ${event.location}\n` : '';

    const prompt =
      `Prepare a briefing for this meeting: ${event.title}\n` +
      `Attendees: ${attendeeList}\n` +
      `${locationLine}\n` +
      `Review recent emails, tracked items, and thread correlations related to the attendees or topic. Summarize key context in 3-5 bullets.`;

    briefings.push({
      eventId: event.id,
      eventTitle: event.title,
      startsAt: event.start_time,
      attendees: event.attendees,
      prompt,
    });

    logger.info(
      { eventId: event.id, title: event.title, startsAt: event.start_time },
      'Meeting briefing: queued briefing for upcoming event',
    );
  }

  return briefings;
}
