import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

import { loadHealthMonitorConfig, resolveJids, validateConfig } from "./health-monitor-config.js";
import type { HealthMonitorConfig } from "./health-monitor-config.js";

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("loadHealthMonitorConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns defaults when file not found (ENOENT)", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const config = loadHealthMonitorConfig("/nonexistent/path.json");
    expect(config).toEqual({
      enabled: false,
      pollIntervalMs: 60000,
      sources: {},
      defaultRoutes: [],
    });
  });

  it("parses valid config", () => {
    const json = JSON.stringify({
      enabled: true,
      pollIntervalMs: 30000,
      sources: {
        tanren: {
          enabled: true,
          routes: [{ eventTypes: ["*"], jids: ["dc:123"] }],
        },
      },
      defaultRoutes: [{ eventTypes: ["*"], jids: ["dc:456"] }],
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(json);

    const config = loadHealthMonitorConfig("/some/path.json");
    expect(config.enabled).toBe(true);
    expect(config.pollIntervalMs).toBe(30000);
    expect(config.sources.tanren.enabled).toBe(true);
    expect(config.sources.tanren.routes).toHaveLength(1);
    expect(config.defaultRoutes).toHaveLength(1);
  });

  it("throws on invalid JSON", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("{invalid json}");
    expect(() => loadHealthMonitorConfig("/bad.json")).toThrow();
  });

  it("applies defaults for missing fields", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("{}");

    const config = loadHealthMonitorConfig("/path.json");
    expect(config.enabled).toBe(false);
    expect(config.pollIntervalMs).toBe(60000);
    expect(config.sources).toEqual({});
    expect(config.defaultRoutes).toEqual([]);
  });

  it("rethrows non-ENOENT read errors", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    expect(() => loadHealthMonitorConfig("/no-access.json")).toThrow("EACCES");
  });
});

describe("validateConfig", () => {
  it("rejects non-object input", () => {
    expect(() => validateConfig("string")).toThrow("must be a JSON object");
    expect(() => validateConfig(null)).toThrow("must be a JSON object");
    expect(() => validateConfig([])).toThrow("must be a JSON object");
  });

  it("validates pollIntervalMs > 0", () => {
    expect(() => validateConfig({ pollIntervalMs: 0 })).toThrow("positive number");
    expect(() => validateConfig({ pollIntervalMs: -1 })).toThrow("positive number");
  });

  it("validates route structure (eventTypes is string[])", () => {
    expect(() =>
      validateConfig({
        defaultRoutes: [{ eventTypes: "not-array", jids: ["dc:1"] }],
      }),
    ).toThrow("eventTypes must be a string array");
  });

  it("validates route structure (jids is string[])", () => {
    expect(() =>
      validateConfig({
        defaultRoutes: [{ eventTypes: ["*"], jids: "not-array" }],
      }),
    ).toThrow("jids must be a string array");
  });

  it("rejects empty jids in routes", () => {
    expect(() =>
      validateConfig({
        defaultRoutes: [{ eventTypes: ["*"], jids: [] }],
      }),
    ).toThrow("jids must not be empty");
  });

  it("rejects empty string in jids", () => {
    expect(() =>
      validateConfig({
        defaultRoutes: [{ eventTypes: ["*"], jids: [""] }],
      }),
    ).toThrow("jids must contain non-empty strings");
  });
});

describe("resolveJids", () => {
  const baseConfig: HealthMonitorConfig = {
    enabled: true,
    pollIntervalMs: 60000,
    sources: {
      tanren: {
        enabled: true,
        routes: [
          { eventTypes: ["error_occurred"], jids: ["dc:errors"] },
          { eventTypes: ["*"], jids: ["dc:all"] },
        ],
      },
      other: {
        enabled: false,
        routes: [{ eventTypes: ["*"], jids: ["dc:disabled"] }],
      },
    },
    defaultRoutes: [{ eventTypes: ["*"], jids: ["dc:default"] }],
  };

  it("matches source-specific route", () => {
    expect(resolveJids(baseConfig, "error_occurred", "tanren")).toEqual(["dc:errors"]);
  });

  it("falls back to defaultRoutes", () => {
    expect(resolveJids(baseConfig, "some_event", "unknown_source")).toEqual(["dc:default"]);
  });

  it("wildcard '*' matches any event type", () => {
    expect(resolveJids(baseConfig, "phase_started", "tanren")).toEqual(["dc:all"]);
  });

  it("returns empty when source disabled", () => {
    // Source 'other' is disabled — its routes should not match, falls through to default
    expect(resolveJids(baseConfig, "anything", "other")).toEqual(["dc:default"]);
  });

  it("returns empty when no route matches", () => {
    const config: HealthMonitorConfig = {
      enabled: true,
      pollIntervalMs: 60000,
      sources: {},
      defaultRoutes: [{ eventTypes: ["specific_type"], jids: ["dc:1"] }],
    };
    expect(resolveJids(config, "other_type", "tanren")).toEqual([]);
  });

  it("first matching rule wins (no duplicates)", () => {
    const config: HealthMonitorConfig = {
      enabled: true,
      pollIntervalMs: 60000,
      sources: {
        tanren: {
          enabled: true,
          routes: [
            { eventTypes: ["*"], jids: ["dc:first"] },
            { eventTypes: ["*"], jids: ["dc:second"] },
          ],
        },
      },
      defaultRoutes: [],
    };
    expect(resolveJids(config, "anything", "tanren")).toEqual(["dc:first"]);
  });
});
