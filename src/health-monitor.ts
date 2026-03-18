import type { DiscordEmbed } from "./types.js";
import type { HealthMonitorConfig } from "./health-monitor-config.js";
import { resolveJids } from "./health-monitor-config.js";
import {
  formatEventEmbed,
  formatHealthStatusEmbed,
  formatMonitorErrorEmbed,
} from "./health-embeds.js";
import { logger } from "./logger.js";

export interface HealthStatus {
  source: string;
  healthy: boolean;
  message: string;
  details?: Record<string, unknown>;
  checkedAt: Date;
}

export interface HealthEvent {
  source: string;
  type: string;
  timestamp: string;
  title: string;
  data: Record<string, unknown>;
}

export interface HealthSource {
  name: string;
  checkHealth(): Promise<HealthStatus | null>;
  fetchEvents(cursor: string | null): Promise<{ events: HealthEvent[]; cursor: string | null }>;
}

export interface HealthMonitorDeps {
  sources: HealthSource[];
  sendEmbed: (jid: string, embed: DiscordEmbed) => Promise<void>;
  getState: (key: string) => string | undefined;
  setState: (key: string, value: string) => void;
  config: HealthMonitorConfig;
}

let monitorRunning = false;

export function startHealthMonitor(deps: HealthMonitorDeps): void {
  if (monitorRunning) {
    logger.debug("Health monitor already running, skipping duplicate start");
    return;
  }
  monitorRunning = true;

  const lastHealthState = new Map<string, boolean>();

  // Initialize from persisted state
  for (const source of deps.sources) {
    const persisted = deps.getState(`health_status_${source.name}`);
    if (persisted !== undefined) {
      lastHealthState.set(source.name, persisted === "true");
    }
  }

  const poll = async () => {
    for (const source of deps.sources) {
      await pollSource(source, deps, lastHealthState);
    }

    if (monitorRunning) {
      setTimeout(poll, deps.config.pollIntervalMs);
    }
  };

  setTimeout(poll, 0);
}

async function pollSource(
  source: HealthSource,
  deps: HealthMonitorDeps,
  lastHealthState: Map<string, boolean>,
): Promise<void> {
  // Health check
  try {
    const status = await source.checkHealth();
    if (status) {
      const previous = lastHealthState.get(source.name) ?? null;

      // Only post on state transitions or first-check-unhealthy
      const shouldPost = previous !== null ? previous !== status.healthy : !status.healthy;

      if (shouldPost) {
        const embed = formatHealthStatusEmbed(status, previous);
        const jids = resolveJids(deps.config, "health_status", source.name);
        let anySendSucceeded = false;
        for (const jid of jids) {
          try {
            await deps.sendEmbed(jid, embed);
            anySendSucceeded = true;
          } catch (err) {
            logger.error({ jid, source: source.name, err }, "Health monitor: sendEmbed failed");
          }
        }
        // Only commit new state if delivery succeeded (or no JIDs to send to).
        // If all sends failed, keep previous state so the transition retries next poll.
        if (anySendSucceeded || jids.length === 0) {
          lastHealthState.set(source.name, status.healthy);
          deps.setState(`health_status_${source.name}`, String(status.healthy));
        }
      } else {
        // No transition — still commit current state (idempotent, no notification needed)
        lastHealthState.set(source.name, status.healthy);
        deps.setState(`health_status_${source.name}`, String(status.healthy));
      }
    }
  } catch (err) {
    logger.error({ source: source.name, err }, "Health monitor: checkHealth threw");
    await sendErrorEmbed(deps, source.name, "Health check error", err);
  }

  // Event polling
  try {
    const cursorKey = `events_cursor_${source.name}`;
    const rawCursor = deps.getState(cursorKey) ?? null;
    const { events, cursor: newCursor } = await source.fetchEvents(rawCursor);

    // On first run (rawCursor was null), skip posting — cursor was just initialized.
    // Commit cursor immediately since there's nothing to deliver.
    if (rawCursor === null) {
      if (newCursor !== null) {
        deps.setState(cursorKey, newCursor);
      }
    } else {
      let allDelivered = true;
      for (const event of events) {
        const embed = formatEventEmbed(event);
        const jids = resolveJids(deps.config, event.type, source.name);
        let eventDelivered = jids.length === 0;
        for (const jid of jids) {
          try {
            await deps.sendEmbed(jid, embed);
            eventDelivered = true;
          } catch (err) {
            logger.error(
              { jid, source: source.name, eventType: event.type, err },
              "Health monitor: sendEmbed failed for event",
            );
          }
        }
        if (!eventDelivered) {
          allDelivered = false;
        }
      }
      // Only advance cursor after successful delivery.
      // If any event failed all sends, keep old cursor to retry next poll.
      if (allDelivered && newCursor !== null) {
        deps.setState(cursorKey, newCursor);
      }
    }
  } catch (err) {
    logger.error({ source: source.name, err }, "Health monitor: fetchEvents threw");
    await sendErrorEmbed(deps, source.name, "Event fetch error", err);
  }
}

async function sendErrorEmbed(
  deps: HealthMonitorDeps,
  sourceName: string,
  context: string,
  err: unknown,
): Promise<void> {
  const embed = formatMonitorErrorEmbed(sourceName, context, err);
  const jids = resolveJids(deps.config, "monitor_error", sourceName);
  for (const jid of jids) {
    try {
      await deps.sendEmbed(jid, embed);
    } catch (sendErr) {
      logger.error({ jid, sourceName, sendErr }, "Health monitor: failed to send error embed");
    }
  }
}

/** @internal - for tests only. */
export function _resetHealthMonitorForTests(): void {
  monitorRunning = false;
}
