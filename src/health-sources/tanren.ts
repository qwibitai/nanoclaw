import type { TanrenClient } from "../tanren/index.js";
import type { TanrenEvent } from "../tanren/types.js";
import type { HealthEvent, HealthSource, HealthStatus } from "../health-monitor.js";

interface EventCursor {
  offset: number;
}

function parseCursor(raw: string | null): EventCursor | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { offset?: unknown };
    if (typeof parsed.offset === "number") return { offset: parsed.offset };
  } catch {
    // Corrupted cursor — treat as null
  }
  return null;
}

function serializeCursor(cursor: EventCursor): string {
  return JSON.stringify(cursor);
}

function formatEventTitle(event: TanrenEvent): string {
  switch (event.type) {
    case "dispatch_received":
      return `Dispatch received: ${event.phase} — ${event.project} (${event.cli})`;
    case "phase_started":
      return `Phase started: ${event.phase}`;
    case "phase_completed":
      return `Phase completed: ${event.phase} — ${event.outcome} (${event.duration_secs}s)`;
    case "preflight_completed":
      return `Preflight ${event.passed ? "passed" : "failed"}`;
    case "postflight_completed":
      return `Postflight completed: ${event.phase}`;
    case "error_occurred":
      return `Error: ${event.phase} — ${event.error}`;
    case "retry_scheduled":
      return `Retry scheduled: ${event.phase} — attempt ${event.attempt}/${event.max_attempts}`;
    case "vm_provisioned":
      return `VM provisioned: ${event.vm_id} (${event.provider})`;
    case "vm_released":
      return `VM released: ${event.vm_id} (${event.duration_secs}s)`;
    case "bootstrap_completed":
      return `Bootstrap completed: ${event.vm_id}`;
  }
}

function mapEventData(event: TanrenEvent): Record<string, unknown> {
  const { timestamp: _ts, type: _type, workflow_id, ...rest } = event;
  return { workflow_id, ...rest };
}

export class TanrenHealthSource implements HealthSource {
  name = "tanren";
  private client: TanrenClient;

  constructor(client: TanrenClient) {
    this.client = client;
  }

  async checkHealth(): Promise<HealthStatus> {
    try {
      const response = await this.client.health();
      return {
        source: this.name,
        healthy: response.status === "ok",
        message: response.status === "ok" ? "API healthy" : `Status: ${response.status}`,
        details: {
          version: response.version,
          uptime_seconds: response.uptime_seconds,
        },
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        source: this.name,
        healthy: false,
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  }

  async fetchEvents(
    cursor: string | null,
  ): Promise<{ events: HealthEvent[]; cursor: string | null }> {
    const parsed = parseCursor(cursor);

    if (parsed === null) {
      // First run: fetch current total to skip historical events
      const result = await this.client.listEvents({ limit: 1, offset: 0 });
      const newCursor: EventCursor = { offset: result.total };
      return { events: [], cursor: serializeCursor(newCursor) };
    }

    // Subsequent runs: fetch events since cursor
    const result = await this.client.listEvents({ offset: parsed.offset, limit: 50 });
    const tanrenEvents = result.events ?? [];

    const events: HealthEvent[] = tanrenEvents.map((event) => ({
      source: this.name,
      type: event.type,
      timestamp: event.timestamp,
      title: formatEventTitle(event),
      data: mapEventData(event),
    }));

    const newCursor: EventCursor = { offset: parsed.offset + tanrenEvents.length };
    return { events, cursor: serializeCursor(newCursor) };
  }
}
