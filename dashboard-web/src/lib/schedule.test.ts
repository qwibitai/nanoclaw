/**
 * Tests for the cron / interval / once humanizer.
 *
 * Why this file exists despite the plan's "minimal testing" stance:
 * the plan scoped down React component testing because TypeScript +
 * manual real-device verification cover the fail-to-render case.
 * humanizeSchedule is a pure function with seven distinct branches,
 * unit tests are the cheapest tool for it, and a real bug (FRI day
 * mapping typo) shipped on this branch and would have been caught
 * by a single assertion in this file. Locking the regression here.
 */

import { describe, expect, it } from "vitest";
import { humanizeSchedule } from "./schedule";
import type { ScheduledTask } from "@/types";

function fakeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "t1",
    group_folder: "telegram_pip_family",
    chat_jid: "test@chat",
    prompt: "do the thing",
    schedule_type: "cron",
    schedule_value: "0 9 * * *",
    context_mode: "group",
    next_run: null,
    last_run: null,
    last_result: null,
    status: "active",
    created_at: "2026-04-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("humanizeSchedule — cron", () => {
  it('every-N-minutes pattern: */5 * * * *', () => {
    expect(humanizeSchedule(fakeTask({ schedule_value: "*/5 * * * *" }))).toBe(
      "every 5 minutes",
    );
  });

  it('daily at 9am: 0 9 * * *', () => {
    expect(humanizeSchedule(fakeTask({ schedule_value: "0 9 * * *" }))).toBe(
      "every day at 9am",
    );
  });

  it('daily at 9:30am: 30 9 * * *', () => {
    expect(humanizeSchedule(fakeTask({ schedule_value: "30 9 * * *" }))).toBe(
      "every day at 9:30am",
    );
  });

  it('daily at 5pm: 0 17 * * *', () => {
    expect(humanizeSchedule(fakeTask({ schedule_value: "0 17 * * *" }))).toBe(
      "every day at 5pm",
    );
  });

  it('weekdays at 9am: 0 9 * * 1-5', () => {
    expect(humanizeSchedule(fakeTask({ schedule_value: "0 9 * * 1-5" }))).toBe(
      "weekdays at 9am",
    );
  });

  it('weekdays alias MON-FRI', () => {
    expect(
      humanizeSchedule(fakeTask({ schedule_value: "0 9 * * MON-FRI" })),
    ).toBe("weekdays at 9am");
  });

  it('weekends at 12pm: 0 12 * * 0,6', () => {
    expect(humanizeSchedule(fakeTask({ schedule_value: "0 12 * * 0,6" }))).toBe(
      "weekends at 12pm",
    );
  });

  // The regression test for the FRI typo. Without this, the cron
  // expression `0 17 * * FRI` was humanized as 'Sat at 5pm'.
  it("named day-of-week FRI is rendered as Fri", () => {
    expect(humanizeSchedule(fakeTask({ schedule_value: "0 17 * * FRI" }))).toBe(
      "Fri at 5pm",
    );
  });

  it("multiple named days MON,WED,FRI", () => {
    expect(
      humanizeSchedule(fakeTask({ schedule_value: "0 9 * * MON,WED,FRI" })),
    ).toBe("Mon, Wed, Fri at 9am");
  });

  it("falls back to raw expression for unrecognized cron shapes", () => {
    expect(
      humanizeSchedule(fakeTask({ schedule_value: "totally not a cron" })),
    ).toBe("totally not a cron");
  });

  it("falls back for 6-field (with seconds) cron", () => {
    expect(
      humanizeSchedule(fakeTask({ schedule_value: "0 0 9 * * *" })),
    ).toBe("0 0 9 * * *");
  });
});

describe("humanizeSchedule — interval", () => {
  it("formats interval with the raw value", () => {
    expect(
      humanizeSchedule(
        fakeTask({ schedule_type: "interval", schedule_value: "10m" }),
      ),
    ).toBe("every 10m");
  });
});

describe("humanizeSchedule — once", () => {
  it("formats a valid ISO timestamp into a localized string", () => {
    const out = humanizeSchedule(
      fakeTask({
        schedule_type: "once",
        schedule_value: "2026-04-08T09:00:00.000Z",
      }),
    );
    // Don't assert exact format because Intl output varies by locale,
    // just confirm the year and a digit appear.
    expect(out).toMatch(/\d/);
    expect(out).not.toBe("2026-04-08T09:00:00.000Z");
  });

  it("falls back to the raw value for an invalid date", () => {
    expect(
      humanizeSchedule(
        fakeTask({ schedule_type: "once", schedule_value: "not-a-date" }),
      ),
    ).toBe("not-a-date");
  });
});
