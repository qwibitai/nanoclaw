import { describe, it, expect } from "vitest";

import {
  COLOR_BLUE,
  COLOR_GREEN,
  COLOR_ORANGE,
  COLOR_RED,
  formatEventEmbed,
  formatHealthStatusEmbed,
  formatMonitorErrorEmbed,
  renderEmbedAsText,
} from "./health-embeds.js";
import type { HealthEvent, HealthStatus } from "./health-monitor.js";

describe("formatHealthStatusEmbed", () => {
  const baseStatus: HealthStatus = {
    source: "tanren",
    healthy: true,
    message: "API healthy",
    details: { version: "1.0.0", uptime_seconds: 3600 },
    checkedAt: new Date("2026-03-18T12:00:00Z"),
  };

  it("uses green color for healthy", () => {
    const embed = formatHealthStatusEmbed(baseStatus, null);
    expect(embed.color).toBe(COLOR_GREEN);
  });

  it("uses red color for unhealthy", () => {
    const embed = formatHealthStatusEmbed({ ...baseStatus, healthy: false }, null);
    expect(embed.color).toBe(COLOR_RED);
  });

  it('shows "Recovered" title on false → true transition', () => {
    const embed = formatHealthStatusEmbed(baseStatus, false);
    expect(embed.title).toBe("tanren: Recovered");
  });

  it('shows "Healthy" title when previous was null (first check)', () => {
    const embed = formatHealthStatusEmbed(baseStatus, null);
    expect(embed.title).toBe("tanren: Healthy");
  });

  it('shows "Unhealthy" title', () => {
    const embed = formatHealthStatusEmbed(
      { ...baseStatus, healthy: false, message: "Connection refused" },
      true,
    );
    expect(embed.title).toBe("tanren: Unhealthy");
  });

  it("maps details to embed fields", () => {
    const embed = formatHealthStatusEmbed(baseStatus, null);
    expect(embed.fields).toEqual([
      { name: "version", value: "1.0.0", inline: true },
      { name: "uptime_seconds", value: "3600", inline: true },
    ]);
  });

  it("sets timestamp from checkedAt", () => {
    const embed = formatHealthStatusEmbed(baseStatus, null);
    expect(embed.timestamp).toBe("2026-03-18T12:00:00.000Z");
  });

  it("omits fields when no details", () => {
    const status = { ...baseStatus, details: undefined };
    const embed = formatHealthStatusEmbed(status, null);
    expect(embed.fields).toBeUndefined();
  });
});

describe("formatEventEmbed", () => {
  const baseEvent: HealthEvent = {
    source: "tanren",
    type: "phase_completed",
    timestamp: "2026-03-18T12:00:00Z",
    title: "Phase completed: do-task — success (45s)",
    data: { phase: "do-task", outcome: "success" },
  };

  it("uses red for error_occurred", () => {
    const embed = formatEventEmbed({ ...baseEvent, type: "error_occurred" });
    expect(embed.color).toBe(COLOR_RED);
  });

  it("uses green for phase_completed", () => {
    const embed = formatEventEmbed(baseEvent);
    expect(embed.color).toBe(COLOR_GREEN);
  });

  it("uses blue for vm_provisioned", () => {
    const embed = formatEventEmbed({ ...baseEvent, type: "vm_provisioned" });
    expect(embed.color).toBe(COLOR_BLUE);
  });

  it("uses blue for vm_released", () => {
    const embed = formatEventEmbed({ ...baseEvent, type: "vm_released" });
    expect(embed.color).toBe(COLOR_BLUE);
  });

  it("uses orange for retry_scheduled", () => {
    const embed = formatEventEmbed({ ...baseEvent, type: "retry_scheduled" });
    expect(embed.color).toBe(COLOR_ORANGE);
  });

  it("includes footer with source and type", () => {
    const embed = formatEventEmbed(baseEvent);
    expect(embed.footer).toEqual({ text: "tanren / phase_completed" });
  });

  it("sets timestamp from event", () => {
    const embed = formatEventEmbed(baseEvent);
    expect(embed.timestamp).toBe("2026-03-18T12:00:00Z");
  });

  it("maps event data to fields", () => {
    const embed = formatEventEmbed(baseEvent);
    expect(embed.fields).toEqual([
      { name: "phase", value: "do-task", inline: true },
      { name: "outcome", value: "success", inline: true },
    ]);
  });
});

describe("formatMonitorErrorEmbed", () => {
  it("uses orange color", () => {
    const embed = formatMonitorErrorEmbed(
      "tanren",
      "Event fetch error",
      new Error("401 Unauthorized"),
    );
    expect(embed.color).toBe(COLOR_ORANGE);
  });

  it("includes source and context in title", () => {
    const embed = formatMonitorErrorEmbed("tanren", "Health check error", new Error("timeout"));
    expect(embed.title).toBe("tanren: Health check error");
  });

  it("extracts message from Error instances", () => {
    const embed = formatMonitorErrorEmbed(
      "tanren",
      "Event fetch error",
      new Error("401 Unauthorized"),
    );
    expect(embed.description).toBe("401 Unauthorized");
  });

  it("handles non-Error values", () => {
    const embed = formatMonitorErrorEmbed("tanren", "Event fetch error", "raw string error");
    expect(embed.description).toBe("raw string error");
  });

  it("sets timestamp", () => {
    const embed = formatMonitorErrorEmbed("tanren", "Error", new Error("x"));
    expect(embed.timestamp).toBeDefined();
  });
});

describe("renderEmbedAsText", () => {
  it("formats title bold, fields as key: value lines", () => {
    const text = renderEmbedAsText({
      title: "tanren: Unhealthy",
      description: "Connection refused",
      fields: [{ name: "version", value: "1.0.0" }],
      footer: { text: "tanren / health_status" },
    });
    expect(text).toBe(
      "**tanren: Unhealthy**\nConnection refused\nversion: 1.0.0\ntanren / health_status",
    );
  });

  it("handles missing optional fields", () => {
    const text = renderEmbedAsText({ title: "Test" });
    expect(text).toBe("**Test**");
  });

  it("handles embed with only description", () => {
    const text = renderEmbedAsText({ description: "Just a description" });
    expect(text).toBe("Just a description");
  });
});
