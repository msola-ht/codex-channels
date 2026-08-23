import { describe, expect, it } from "vitest";

import {
  calculateNextRunAt,
  isValidIanaTimeZone,
  normalizeSchedule,
  normalizeWeekdays,
  ScheduleValidationError,
  validateIanaTimeZone,
} from "../src/scheduled-tasks/index.js";

describe("scheduled task Schedule domain", () => {
  it("normalizes the four closed Schedule variants", () => {
    expect(normalizeSchedule({ type: "hourly", intervalHours: 2, anchorAt: 1_700_000_000_000 })).toEqual({
      type: "hourly",
      intervalHours: 2,
      anchorAt: 1_700_000_000_000,
    });
    expect(normalizeSchedule({ type: "daily", time: "08:05" })).toEqual({ type: "daily", time: "08:05" });
    expect(normalizeSchedule({ type: "weekdays", time: "09:00" })).toEqual({ type: "weekdays", time: "09:00" });
    expect(normalizeSchedule({ type: "weekly", days: ["FR", "MO"], time: "17:30" })).toEqual({
      type: "weekly",
      days: ["MO", "FR"],
      time: "17:30",
    });
  });

  it("rejects invalid local times, weekday lists, and time zones", () => {
    expect(() => normalizeSchedule({ type: "daily", time: "24:00" })).toThrow(ScheduleValidationError);
    expect(() => normalizeWeekdays([])).toThrow(ScheduleValidationError);
    expect(() => normalizeWeekdays(["MO", "MO"])).toThrow(ScheduleValidationError);
    expect(() => validateIanaTimeZone("Not/A_Timezone")).toThrow(ScheduleValidationError);
    expect(isValidIanaTimeZone(null)).toBe(false);
    expect(isValidIanaTimeZone(123)).toBe(false);
    expect(() => validateIanaTimeZone(null)).toThrow(ScheduleValidationError);
  });

  it("rejects non-integer and out-of-range timestamps and intervals", () => {
    expect(() => calculateNextRunAt({ type: "daily", time: "08:00" }, "UTC", 1.5))
      .toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "hourly", intervalHours: 1.5, anchorAt: 0 }))
      .toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "hourly", intervalHours: Number.MAX_SAFE_INTEGER, anchorAt: 0 }))
      .toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "hourly", intervalHours: 1, anchorAt: Number.MAX_SAFE_INTEGER }))
      .toThrow(ScheduleValidationError);
  });

  it("keeps hourly occurrences at fixed UTC intervals", () => {
    const anchor = Date.parse("2026-01-01T00:00:00.000Z");
    expect(calculateNextRunAt({ type: "hourly", intervalHours: 3, anchorAt: anchor }, "UTC", anchor))
      .toBe(anchor + 3 * 60 * 60 * 1_000);
  });

  it("calculates daily, weekday, and weekly local occurrences", () => {
    const monday = Date.parse("2026-01-05T00:00:00.000Z");
    expect(calculateNextRunAt({ type: "daily", time: "08:30" }, "UTC", monday))
      .toBe(Date.parse("2026-01-05T08:30:00.000Z"));
    const saturday = Date.parse("2026-01-10T12:00:00.000Z");
    expect(calculateNextRunAt({ type: "weekdays", time: "09:00" }, "UTC", saturday))
      .toBe(Date.parse("2026-01-12T09:00:00.000Z"));
    expect(calculateNextRunAt({ type: "weekly", days: ["WE"], time: "10:00" }, "UTC", monday))
      .toBe(Date.parse("2026-01-07T10:00:00.000Z"));
  });

  it("skips a local time that does not exist during the DST spring gap", () => {
    const beforeGap = Date.parse("2026-03-07T12:00:00.000Z");
    expect(calculateNextRunAt({ type: "daily", time: "02:30" }, "America/New_York", beforeGap))
      .toBe(Date.parse("2026-03-09T06:30:00.000Z"));
  });

  it("runs only the first instant of a repeated local time during the DST fall fold", () => {
    const beforeFold = Date.parse("2026-10-31T12:00:00.000Z");
    const first = Date.parse("2026-11-01T05:30:00.000Z");
    expect(calculateNextRunAt({ type: "daily", time: "01:30" }, "America/New_York", beforeFold)).toBe(first);
    expect(calculateNextRunAt({ type: "daily", time: "01:30" }, "America/New_York", first))
      .toBe(Date.parse("2026-11-02T06:30:00.000Z"));
  });

  it("does not depend on the host process time zone", () => {
    const after = Date.parse("2026-06-01T00:00:00.000Z");
    const next = calculateNextRunAt({ type: "daily", time: "09:00" }, "Asia/Shanghai", after);
    expect(next).toBe(Date.parse("2026-06-01T01:00:00.000Z"));
  });

  it("uses bounded offset probes instead of a per-minute UTC scan", () => {
    const prototype = Intl.DateTimeFormat.prototype;
    const original = prototype.formatToParts;
    let calls = 0;
    prototype.formatToParts = function formatToParts(this: Intl.DateTimeFormat, value?: Date | number) {
      calls += 1;
      return original.call(this, value);
    };
    try {
      expect(calculateNextRunAt(
        { type: "daily", time: "09:00" },
        "Australia/Lord_Howe",
        Date.parse("2026-04-01T00:00:00.000Z"),
      )).toBe(Date.parse("2026-04-01T22:00:00.000Z"));
      expect(calls).toBeLessThan(100);
    } finally {
      prototype.formatToParts = original;
    }
  });
});
