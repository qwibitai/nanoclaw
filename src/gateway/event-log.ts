import crypto from 'crypto';
import type { ActivityEvent } from '../shared/types.js';

const MAX_EVENTS = 100;

const events: ActivityEvent[] = [];

export function logEvent(
  event: Omit<ActivityEvent, 'id' | 'timestamp'>,
): ActivityEvent {
  const full: ActivityEvent = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  };
  events.push(full);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  return full;
}

export function getRecentEvents(count = 50): ActivityEvent[] {
  return events.slice(-count).reverse();
}
