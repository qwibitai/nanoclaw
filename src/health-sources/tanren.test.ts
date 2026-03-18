import { describe, it, expect, vi } from "vitest";

import { TanrenClient } from "../tanren/index.js";
import type { HealthResponse, PaginatedEvents, TanrenEvent } from "../tanren/types.js";

import { TanrenHealthSource } from "./tanren.js";

vi.mock("../logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createMockClient(overrides?: Partial<TanrenClient>) {
  return {
    health: vi.fn<() => Promise<HealthResponse>>(),
    listEvents: vi.fn<() => Promise<PaginatedEvents>>(),
    ...overrides,
  } as unknown as TanrenClient;
}

describe("TanrenHealthSource", () => {
  describe("checkHealth", () => {
    it("returns healthy status from successful API response", async () => {
      const client = createMockClient();
      vi.mocked(client.health).mockResolvedValue({
        status: "ok",
        version: "1.2.3",
        uptime_seconds: 3600,
      });

      const source = new TanrenHealthSource(client);
      const status = await source.checkHealth();

      expect(status).toMatchObject({
        source: "tanren",
        healthy: true,
        message: "API healthy",
        details: { version: "1.2.3", uptime_seconds: 3600 },
      });
      expect(status.checkedAt).toBeInstanceOf(Date);
    });

    it("returns unhealthy on API error (catch path)", async () => {
      const client = createMockClient();
      vi.mocked(client.health).mockRejectedValue(new Error("Connection refused"));

      const source = new TanrenHealthSource(client);
      const status = await source.checkHealth();

      expect(status).toMatchObject({
        source: "tanren",
        healthy: false,
        message: "Connection refused",
      });
    });

    it("maps version + uptime_seconds to details", async () => {
      const client = createMockClient();
      vi.mocked(client.health).mockResolvedValue({
        status: "ok",
        version: "2.0.0",
        uptime_seconds: 86400,
      });

      const source = new TanrenHealthSource(client);
      const status = await source.checkHealth();

      expect(status.details).toEqual({ version: "2.0.0", uptime_seconds: 86400 });
    });

    it("handles non-ok status gracefully", async () => {
      const client = createMockClient();
      vi.mocked(client.health).mockResolvedValue({
        status: "degraded",
        version: "1.0.0",
        uptime_seconds: 100,
      });

      const source = new TanrenHealthSource(client);
      const status = await source.checkHealth();

      expect(status.healthy).toBe(false);
      expect(status.message).toBe("Status: degraded");
    });
  });

  describe("fetchEvents", () => {
    it("returns empty events + initial cursor on first fetch (null cursor)", async () => {
      const client = createMockClient();
      vi.mocked(client.listEvents).mockResolvedValue({
        events: [],
        total: 150,
        limit: 1,
        offset: 0,
      });

      const source = new TanrenHealthSource(client);
      const result = await source.fetchEvents(null);

      expect(result.events).toEqual([]);
      expect(result.cursor).toBe(JSON.stringify({ offset: 150 }));
      expect(client.listEvents).toHaveBeenCalledWith({ limit: 1, offset: 0 });
    });

    it("sets cursor to { offset: total } on init (skip to end)", async () => {
      const client = createMockClient();
      vi.mocked(client.listEvents).mockResolvedValue({
        events: [],
        total: 42,
        limit: 1,
        offset: 0,
      });

      const source = new TanrenHealthSource(client);
      const result = await source.fetchEvents(null);

      expect(JSON.parse(result.cursor!)).toEqual({ offset: 42 });
    });

    it("maps each TanrenEvent type to HealthEvent with correct title", async () => {
      const events: TanrenEvent[] = [
        {
          timestamp: "2026-03-18T12:00:00Z",
          workflow_id: "wf-1",
          type: "dispatch_received",
          phase: "do-task",
          project: "myproj",
          cli: "claude",
        },
        {
          timestamp: "2026-03-18T12:01:00Z",
          workflow_id: "wf-1",
          type: "phase_completed",
          phase: "do-task",
          outcome: "success",
          signal: null,
          duration_secs: 45,
          exit_code: 0,
        },
      ];

      const client = createMockClient();
      vi.mocked(client.listEvents).mockResolvedValue({
        events,
        total: 152,
        limit: 50,
        offset: 150,
      });

      const source = new TanrenHealthSource(client);
      const result = await source.fetchEvents(JSON.stringify({ offset: 150 }));

      expect(result.events).toHaveLength(2);
      expect(result.events[0].title).toBe("Dispatch received: do-task — myproj (claude)");
      expect(result.events[0].type).toBe("dispatch_received");
      expect(result.events[0].source).toBe("tanren");
      expect(result.events[1].title).toBe("Phase completed: do-task — success (45s)");
    });

    it("advances offset cursor by events.length", async () => {
      const client = createMockClient();
      vi.mocked(client.listEvents).mockResolvedValue({
        events: [
          {
            timestamp: "2026-03-18T12:00:00Z",
            workflow_id: "wf-1",
            type: "phase_started",
            phase: "do-task",
            worktree_path: "/tmp/wt",
          },
        ],
        total: 151,
        limit: 50,
        offset: 150,
      });

      const source = new TanrenHealthSource(client);
      const result = await source.fetchEvents(JSON.stringify({ offset: 150 }));

      expect(JSON.parse(result.cursor!)).toEqual({ offset: 151 });
    });

    it("handles empty events array from API", async () => {
      const client = createMockClient();
      vi.mocked(client.listEvents).mockResolvedValue({
        events: [],
        total: 150,
        limit: 50,
        offset: 150,
      });

      const source = new TanrenHealthSource(client);
      const result = await source.fetchEvents(JSON.stringify({ offset: 150 }));

      expect(result.events).toEqual([]);
      expect(JSON.parse(result.cursor!)).toEqual({ offset: 150 });
    });

    it("handles corrupted cursor gracefully (treats as null)", async () => {
      const client = createMockClient();
      vi.mocked(client.listEvents).mockResolvedValue({
        events: [],
        total: 100,
        limit: 1,
        offset: 0,
      });

      const source = new TanrenHealthSource(client);
      const result = await source.fetchEvents("not-valid-json");

      // Should behave like null cursor (first run)
      expect(result.events).toEqual([]);
      expect(client.listEvents).toHaveBeenCalledWith({ limit: 1, offset: 0 });
    });

    it("maps all event types correctly", async () => {
      const events: TanrenEvent[] = [
        {
          timestamp: "t",
          workflow_id: "w",
          type: "dispatch_received",
          phase: "p",
          project: "proj",
          cli: "claude",
        },
        { timestamp: "t", workflow_id: "w", type: "phase_started", phase: "p", worktree_path: "/" },
        {
          timestamp: "t",
          workflow_id: "w",
          type: "phase_completed",
          phase: "p",
          outcome: "success",
          duration_secs: 10,
          exit_code: 0,
        },
        {
          timestamp: "t",
          workflow_id: "w",
          type: "preflight_completed",
          passed: true,
        },
        {
          timestamp: "t",
          workflow_id: "w",
          type: "postflight_completed",
          phase: "p",
        },
        {
          timestamp: "t",
          workflow_id: "w",
          type: "error_occurred",
          phase: "p",
          error: "boom",
        },
        {
          timestamp: "t",
          workflow_id: "w",
          type: "retry_scheduled",
          phase: "p",
          attempt: 1,
          max_attempts: 3,
          backoff_secs: 30,
        },
        {
          timestamp: "t",
          workflow_id: "w",
          type: "vm_provisioned",
          vm_id: "vm1",
          host: "h",
          provider: "hetzner",
          project: "proj",
          profile: "default",
        },
        {
          timestamp: "t",
          workflow_id: "w",
          type: "vm_released",
          vm_id: "vm1",
          duration_secs: 600,
        },
        {
          timestamp: "t",
          workflow_id: "w",
          type: "bootstrap_completed",
          vm_id: "vm1",
        },
      ];

      const client = createMockClient();
      vi.mocked(client.listEvents).mockResolvedValue({
        events,
        total: 10,
        limit: 50,
        offset: 0,
      });

      const source = new TanrenHealthSource(client);
      const result = await source.fetchEvents(JSON.stringify({ offset: 0 }));

      expect(result.events).toHaveLength(10);

      const titles = result.events.map((e) => e.title);
      expect(titles[0]).toContain("Dispatch received");
      expect(titles[1]).toContain("Phase started");
      expect(titles[2]).toContain("Phase completed");
      expect(titles[3]).toContain("Preflight passed");
      expect(titles[4]).toContain("Postflight completed");
      expect(titles[5]).toContain("Error");
      expect(titles[6]).toContain("Retry scheduled");
      expect(titles[7]).toContain("VM provisioned");
      expect(titles[8]).toContain("VM released");
      expect(titles[9]).toContain("Bootstrap completed");
    });

    it("handles undefined events in API response", async () => {
      const client = createMockClient();
      vi.mocked(client.listEvents).mockResolvedValue({
        total: 0,
        limit: 50,
        offset: 0,
      } as PaginatedEvents);

      const source = new TanrenHealthSource(client);
      const result = await source.fetchEvents(JSON.stringify({ offset: 0 }));

      expect(result.events).toEqual([]);
    });
  });
});
