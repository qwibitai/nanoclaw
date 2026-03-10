import { describe, it, expect } from "vitest";

import { formatLocalTime } from "./timezone.js";

// --- formatLocalTime ---

describe("formatLocalTime", () => {
  it("converts UTC to local time display", () => {
    // 2026-02-04T18:30:00Z in America/New_York (EST, UTC-5) = 1:30 PM
    const result = formatLocalTime("2026-02-04T18:30:00.000Z", "America/New_York");
    expect(result).toContain("1:30");
    expect(result).toContain("PM");
    expect(result).toContain("Feb");
    expect(result).toContain("2026");
  });

  it("handles different timezones", () => {
    // Same UTC time should produce different local times
    const utc = "2026-06-15T12:00:00.000Z";
    const ny = formatLocalTime(utc, "America/New_York");
    const tokyo = formatLocalTime(utc, "Asia/Tokyo");
    // NY is UTC-4 in summer (EDT), Tokyo is UTC+9
    expect(ny).toContain("8:00");
    expect(tokyo).toContain("9:00");
  });
});
