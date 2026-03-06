import { EVENT_BRIDGE_ENABLED, EVENT_BRIDGE_URL } from './config.js';
import { logger } from './logger.js';

export interface BridgeEvent {
  event_type: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

// Throttle: skip worker_progress if summary unchanged for same run_id
const progressLastSummary = new Map<string, string>();

function enrichMetadata(event: BridgeEvent): BridgeEvent {
  const tier = event.metadata?.tier as string | undefined;
  const agent = event.metadata?.agent as string | undefined;
  const sourceLane = tier === 'andy-developer' ? 'andy-developer' : 'jarvis-worker';
  const sourceLabel = tier === 'andy-developer' ? 'Andy Developer' : (agent ?? 'Jarvis Worker');
  return {
    ...event,
    metadata: { ...event.metadata, source_lane: sourceLane, source_label: sourceLabel },
  };
}

export async function emitBridgeEvent(event: BridgeEvent): Promise<void> {
  if (!EVENT_BRIDGE_ENABLED) return;

  if (event.event_type === 'worker_progress') {
    const runId = (event.metadata?.run_id as string) || '';
    const prev = progressLastSummary.get(runId);
    if (prev === event.summary) return;
    progressLastSummary.set(runId, event.summary);
  }

  const enriched = enrichMetadata(event);

  try {
    await fetch(EVENT_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enriched),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    logger.debug({ event_type: event.event_type }, 'event bridge emit failed (ignored)');
  }
}
