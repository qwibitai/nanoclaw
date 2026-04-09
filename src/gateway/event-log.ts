/**
 * Gateway event log — delegates to the Nexus Store.
 *
 * Previously held events in-memory (lost on restart).
 * Now persists via the store process.
 */

import type { ActivityEvent } from '../shared/types.ts';
import * as store from '../shared/store-client.ts';

export function logEvent(
  event: Omit<ActivityEvent, 'id' | 'timestamp'>,
): void {
  // Fire-and-forget: don't block the caller waiting for persistence
  store.logEvent(event).catch(() => {});
}

export async function getRecentEvents(
  count = 50,
): Promise<ActivityEvent[]> {
  return store.listEvents(count);
}
