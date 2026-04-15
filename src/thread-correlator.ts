import { CALENDAR_LOOKAHEAD_MS } from './config.js';
import { getDb } from './db.js';
import { eventBus } from './event-bus.js';
import { getUpcomingEvents } from './calendar-poller.js';
import { getActiveThreads, type TrackedItem } from './tracked-items.js';
import { logger } from './logger.js';

export interface ThreadLink {
  thread_id: string;
  item_id: string;
  link_type: 'attendee_match' | 'subject_match' | 'temporal';
  confidence: number;
  created_at: number;
}

/**
 * Strip RE:, FWD:, FW: prefixes (repeated), then trim and lowercase.
 */
function normalizeSubject(text: string): string {
  const prefixPattern = /^(re|fwd|fw)\s*:\s*/i;
  let normalized = text;
  while (prefixPattern.test(normalized)) {
    normalized = normalized.replace(prefixPattern, '');
  }
  return normalized.trim().toLowerCase();
}

/**
 * Persist a thread link, silently ignoring duplicates.
 */
function storeThreadLink(link: ThreadLink): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO thread_links (thread_id, item_id, link_type, confidence, created_at)
     VALUES (@thread_id, @item_id, @link_type, @confidence, @created_at)`,
  ).run(link);
}

/**
 * Emit thread.correlated event for a newly created link.
 */
function emitCorrelated(link: ThreadLink): void {
  eventBus.emit('thread.correlated', {
    type: 'thread.correlated',
    source: 'thread-correlator',
    timestamp: Date.now(),
    payload: {
      threadId: link.thread_id,
      itemId: link.item_id,
      linkType: link.link_type,
      confidence: link.confidence,
    },
  });
}

/**
 * Correlate an item to calendar events by matching the item sender against
 * event attendees (case-insensitive).
 */
export function correlateByAttendee(item: TrackedItem): ThreadLink[] {
  const sender = item.metadata?.['sender'];
  if (typeof sender !== 'string' || !sender) {
    return [];
  }

  const senderLower = sender.toLowerCase();
  const events = getUpcomingEvents(Date.now(), CALENDAR_LOOKAHEAD_MS);
  const links: ThreadLink[] = [];

  for (const evt of events) {
    const matched = evt.attendees.some((a) => a.toLowerCase() === senderLower);
    if (!matched) continue;

    const link: ThreadLink = {
      thread_id: `cal:${evt.id}`,
      item_id: item.id,
      link_type: 'attendee_match',
      confidence: 0.85,
      created_at: Date.now(),
    };

    storeThreadLink(link);
    emitCorrelated(link);
    links.push(link);

    logger.debug(
      { threadId: link.thread_id, itemId: item.id },
      'Attendee match correlated',
    );
  }

  return links;
}

/**
 * Correlate an item to active threads by matching normalized titles.
 * Exact match → confidence 0.9; substring match → confidence 0.7.
 */
export function correlateBySubject(
  item: TrackedItem,
  groupName: string,
): ThreadLink[] {
  const normalizedItem = normalizeSubject(item.title);
  if (normalizedItem.length < 5) {
    return [];
  }

  const threads = getActiveThreads(groupName);
  const links: ThreadLink[] = [];

  for (const thread of threads) {
    const normalizedThread = normalizeSubject(thread.title);

    let confidence: number | null = null;
    if (normalizedItem === normalizedThread) {
      confidence = 0.9;
    } else if (
      normalizedItem.includes(normalizedThread) ||
      normalizedThread.includes(normalizedItem)
    ) {
      confidence = 0.7;
    }

    if (confidence === null) continue;

    const link: ThreadLink = {
      thread_id: thread.id,
      item_id: item.id,
      link_type: 'subject_match',
      confidence,
      created_at: Date.now(),
    };

    storeThreadLink(link);
    emitCorrelated(link);
    links.push(link);

    logger.debug(
      { threadId: link.thread_id, itemId: item.id, confidence },
      'Subject match correlated',
    );
  }

  return links;
}

/**
 * Get all thread links for a given thread ID.
 */
export function getThreadLinks(threadId: string): ThreadLink[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT thread_id, item_id, link_type, confidence, created_at
       FROM thread_links WHERE thread_id = ?`,
    )
    .all(threadId) as ThreadLink[];
}

/**
 * Get all thread links for a given item ID.
 */
export function getItemThreadLinks(itemId: string): ThreadLink[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT thread_id, item_id, link_type, confidence, created_at
       FROM thread_links WHERE item_id = ?`,
    )
    .all(itemId) as ThreadLink[];
}
