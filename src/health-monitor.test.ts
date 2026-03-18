import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { HealthMonitorConfig } from "./health-monitor-config.js";
import type {
  HealthEvent,
  HealthMonitorDeps,
  HealthSource,
  HealthStatus,
} from "./health-monitor.js";
import { _resetHealthMonitorForTests, startHealthMonitor } from "./health-monitor.js";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Helpers ---

function createMockSource(name: string, overrides?: Partial<HealthSource>): HealthSource {
  return {
    name,
    checkHealth: vi.fn<() => Promise<HealthStatus | null>>().mockResolvedValue({
      source: name,
      healthy: true,
      message: "OK",
      checkedAt: new Date("2026-03-18T12:00:00Z"),
    }),
    fetchEvents: vi
      .fn<(cursor: string | null) => Promise<{ events: HealthEvent[]; cursor: string | null }>>()
      .mockResolvedValue({ events: [], cursor: '{"offset":0}' }),
    ...overrides,
  };
}

function createConfig(overrides?: Partial<HealthMonitorConfig>): HealthMonitorConfig {
  return {
    enabled: true,
    pollIntervalMs: 60000,
    sources: {
      test: {
        enabled: true,
        routes: [{ eventTypes: ["*"], jids: ["dc:123"] }],
      },
    },
    defaultRoutes: [{ eventTypes: ["*"], jids: ["dc:123"] }],
    ...overrides,
  };
}

function createDeps(overrides?: Partial<HealthMonitorDeps>): HealthMonitorDeps {
  const state = new Map<string, string>();
  return {
    sources: [createMockSource("test")],
    sendEmbed: vi.fn<(jid: string, embed: unknown) => Promise<void>>().mockResolvedValue(undefined),
    getState: vi.fn((key: string) => state.get(key)),
    setState: vi.fn((key: string, value: string) => state.set(key, value)),
    config: createConfig(),
    ...overrides,
  };
}

// --- Tests ---

describe("Health Monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetHealthMonitorForTests();
  });

  afterEach(() => {
    _resetHealthMonitorForTests();
    vi.useRealTimers();
  });

  // --- Monitor loop ---

  describe("monitor loop", () => {
    it("polls at configured interval", async () => {
      const source = createMockSource("test");
      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);

      // First poll is scheduled with setTimeout(poll, 0)
      await vi.advanceTimersByTimeAsync(0);
      expect(source.checkHealth).toHaveBeenCalledTimes(1);

      // Advance to next poll
      await vi.advanceTimersByTimeAsync(60000);
      expect(source.checkHealth).toHaveBeenCalledTimes(2);
    });

    it("skips when no sources", async () => {
      const deps = createDeps({ sources: [] });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).not.toHaveBeenCalled();
    });

    it("double-start guard (second call is no-op)", async () => {
      const source = createMockSource("test");
      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);
      startHealthMonitor(deps); // Second call

      await vi.advanceTimersByTimeAsync(0);

      // Only one poll should have happened
      expect(source.checkHealth).toHaveBeenCalledTimes(1);
    });

    it("_resetHealthMonitorForTests allows re-entry", async () => {
      const source = createMockSource("test");
      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);
      expect(source.checkHealth).toHaveBeenCalledTimes(1);

      _resetHealthMonitorForTests();

      const source2 = createMockSource("test");
      const deps2 = createDeps({ sources: [source2] });
      startHealthMonitor(deps2);
      await vi.advanceTimersByTimeAsync(0);
      expect(source2.checkHealth).toHaveBeenCalledTimes(1);
    });
  });

  // --- Health state transitions ---

  describe("health state transitions", () => {
    it("posts embed on healthy → unhealthy", async () => {
      const state = new Map<string, string>();
      state.set("health_status_test", "true"); // Previous: healthy

      const source = createMockSource("test", {
        checkHealth: vi.fn().mockResolvedValue({
          source: "test",
          healthy: false,
          message: "Down",
          checkedAt: new Date(),
        }),
      });

      const deps = createDeps({
        sources: [source],
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).toHaveBeenCalled();
    });

    it("posts embed on unhealthy → healthy (recovery)", async () => {
      const state = new Map<string, string>();
      state.set("health_status_test", "false"); // Previous: unhealthy

      const source = createMockSource("test");

      const deps = createDeps({
        sources: [source],
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).toHaveBeenCalled();
      const embed = vi.mocked(deps.sendEmbed).mock.calls[0][1];
      expect(embed.title).toContain("Recovered");
    });

    it("does NOT post on healthy → healthy", async () => {
      const state = new Map<string, string>();
      state.set("health_status_test", "true");

      const source = createMockSource("test");
      const deps = createDeps({
        sources: [source],
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).not.toHaveBeenCalled();
    });

    it("does NOT post on unhealthy → unhealthy", async () => {
      const state = new Map<string, string>();
      state.set("health_status_test", "false");

      const source = createMockSource("test", {
        checkHealth: vi.fn().mockResolvedValue({
          source: "test",
          healthy: false,
          message: "Still down",
          checkedAt: new Date(),
        }),
      });

      const deps = createDeps({
        sources: [source],
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).not.toHaveBeenCalled();
    });

    it("posts on first check if unhealthy (no previous state)", async () => {
      const source = createMockSource("test", {
        checkHealth: vi.fn().mockResolvedValue({
          source: "test",
          healthy: false,
          message: "Down",
          checkedAt: new Date(),
        }),
      });

      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).toHaveBeenCalled();
    });

    it("does NOT post on first check if healthy", async () => {
      const source = createMockSource("test");
      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).not.toHaveBeenCalled();
    });

    it("persists state via setState after each check", async () => {
      const source = createMockSource("test");
      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.setState).toHaveBeenCalledWith("health_status_test", "true");
    });
  });

  // --- Event cursor ---

  describe("event cursor", () => {
    it("skips historical events on first run (null cursor → save cursor, no posts)", async () => {
      const source = createMockSource("test", {
        fetchEvents: vi.fn().mockResolvedValue({
          events: [],
          cursor: '{"offset":100}',
        }),
      });

      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      // Cursor saved but no events posted
      expect(deps.setState).toHaveBeenCalledWith("events_cursor_test", '{"offset":100}');
      // sendEmbed should not have been called for events (health is healthy + first check = no post)
      expect(deps.sendEmbed).not.toHaveBeenCalled();
    });

    it("posts new events on subsequent runs", async () => {
      const state = new Map<string, string>();
      state.set("health_status_test", "true");
      state.set("events_cursor_test", '{"offset":100}');

      const source = createMockSource("test", {
        fetchEvents: vi.fn().mockResolvedValue({
          events: [
            {
              source: "test",
              type: "phase_completed",
              timestamp: "2026-03-18T12:00:00Z",
              title: "Phase completed",
              data: { phase: "do-task" },
            },
          ],
          cursor: '{"offset":101}',
        }),
      });

      const deps = createDeps({
        sources: [source],
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).toHaveBeenCalled();
    });

    it("advances and persists cursor after processing", async () => {
      const state = new Map<string, string>();
      state.set("events_cursor_test", '{"offset":100}');
      state.set("health_status_test", "true");

      const source = createMockSource("test", {
        fetchEvents: vi.fn().mockResolvedValue({
          events: [],
          cursor: '{"offset":105}',
        }),
      });

      const deps = createDeps({
        sources: [source],
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.setState).toHaveBeenCalledWith("events_cursor_test", '{"offset":105}');
    });

    it("handles empty event list gracefully", async () => {
      const state = new Map<string, string>();
      state.set("events_cursor_test", '{"offset":100}');
      state.set("health_status_test", "true");

      const source = createMockSource("test", {
        fetchEvents: vi.fn().mockResolvedValue({
          events: [],
          cursor: '{"offset":100}',
        }),
      });

      const deps = createDeps({
        sources: [source],
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).not.toHaveBeenCalled();
    });
  });

  // --- Error handling ---

  describe("error handling", () => {
    it("continues loop when checkHealth throws", async () => {
      const source = createMockSource("test", {
        checkHealth: vi.fn().mockRejectedValue(new Error("boom")),
      });

      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      // Should still schedule next poll
      await vi.advanceTimersByTimeAsync(60000);
      expect(source.checkHealth).toHaveBeenCalledTimes(2);
    });

    it("continues loop when fetchEvents throws", async () => {
      const source = createMockSource("test", {
        fetchEvents: vi.fn().mockRejectedValue(new Error("fetch error")),
      });

      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(60000);
      expect(source.fetchEvents).toHaveBeenCalledTimes(2);
    });

    it("logs but continues when sendEmbed fails for one JID", async () => {
      const state = new Map<string, string>();
      state.set("health_status_test", "true"); // healthy → will become unhealthy
      state.set("events_cursor_test", '{"offset":0}');

      const source = createMockSource("test", {
        checkHealth: vi.fn().mockResolvedValue({
          source: "test",
          healthy: false,
          message: "Down",
          checkedAt: new Date(),
        }),
      });

      const sendEmbed = vi.fn().mockRejectedValue(new Error("send failed"));

      const deps = createDeps({
        sources: [source],
        sendEmbed,
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      // Monitor should not crash — next poll should work
      await vi.advanceTimersByTimeAsync(60000);
      expect(source.checkHealth).toHaveBeenCalledTimes(2);
    });

    it("sends error embed to Discord when fetchEvents throws", async () => {
      const state = new Map<string, string>();
      state.set("health_status_test", "true");

      const source = createMockSource("test", {
        fetchEvents: vi.fn().mockRejectedValue(new Error("401 Unauthorized")),
      });

      const deps = createDeps({
        sources: [source],
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      // Should have sent an error embed (health was stable, so only event-error embed)
      expect(deps.sendEmbed).toHaveBeenCalledWith(
        "dc:123",
        expect.objectContaining({ title: "test: Event fetch error" }),
      );
    });

    it("sends error embed to Discord when checkHealth throws", async () => {
      const source = createMockSource("test", {
        checkHealth: vi.fn().mockRejectedValue(new Error("Connection refused")),
        fetchEvents: vi.fn().mockRejectedValue(new Error("also broken")),
      });

      const deps = createDeps({ sources: [source] });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).toHaveBeenCalledWith(
        "dc:123",
        expect.objectContaining({ title: "test: Health check error" }),
      );
    });

    it("continues to next source when one source errors", async () => {
      const source1 = createMockSource("broken", {
        checkHealth: vi.fn().mockRejectedValue(new Error("broken")),
        fetchEvents: vi.fn().mockRejectedValue(new Error("broken")),
      });
      const source2 = createMockSource("working");

      const deps = createDeps({
        sources: [source1, source2],
        config: createConfig({
          sources: {
            broken: { enabled: true, routes: [{ eventTypes: ["*"], jids: ["dc:123"] }] },
            working: { enabled: true, routes: [{ eventTypes: ["*"], jids: ["dc:123"] }] },
          },
        }),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      // source2 should still be polled even though source1 errored
      expect(source2.checkHealth).toHaveBeenCalledTimes(1);
      expect(source2.fetchEvents).toHaveBeenCalledTimes(1);
    });
  });

  // --- Routing ---

  describe("routing", () => {
    it("routes events to correct JIDs per config", async () => {
      const state = new Map<string, string>();
      state.set("health_status_test", "true");
      state.set("events_cursor_test", '{"offset":0}');

      const source = createMockSource("test", {
        fetchEvents: vi.fn().mockResolvedValue({
          events: [
            {
              source: "test",
              type: "error_occurred",
              timestamp: "t",
              title: "Error",
              data: {},
            },
          ],
          cursor: '{"offset":1}',
        }),
      });

      const config = createConfig({
        sources: {
          test: {
            enabled: true,
            routes: [
              { eventTypes: ["error_occurred"], jids: ["dc:errors"] },
              { eventTypes: ["*"], jids: ["dc:all"] },
            ],
          },
        },
        defaultRoutes: [],
      });

      const deps = createDeps({
        sources: [source],
        config,
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).toHaveBeenCalledWith(
        "dc:errors",
        expect.objectContaining({ title: "Error" }),
      );
    });

    it("no-ops when no JIDs match", async () => {
      const state = new Map<string, string>();
      state.set("health_status_test", "true");
      state.set("events_cursor_test", '{"offset":0}');

      const source = createMockSource("test", {
        checkHealth: vi.fn().mockResolvedValue({
          source: "test",
          healthy: false,
          message: "Down",
          checkedAt: new Date(),
        }),
        fetchEvents: vi.fn().mockResolvedValue({
          events: [
            { source: "test", type: "custom_event", timestamp: "t", title: "Custom", data: {} },
          ],
          cursor: '{"offset":1}',
        }),
      });

      const config = createConfig({
        sources: {},
        defaultRoutes: [{ eventTypes: ["specific_only"], jids: ["dc:1"] }],
      });

      const deps = createDeps({
        sources: [source],
        config,
        getState: vi.fn((key: string) => state.get(key)),
        setState: vi.fn((key: string, value: string) => state.set(key, value)),
      });

      startHealthMonitor(deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.sendEmbed).not.toHaveBeenCalled();
    });
  });
});
