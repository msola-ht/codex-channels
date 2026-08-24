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
  it("normalizes the closed Schedule variants", () => {
    expect(normalizeSchedule({ type: "interval", intervalMinutes: 120, anchorAt: 1_700_000_000_000 })).toEqual({
      type: "interval",
      intervalMinutes: 120,
      anchorAt: 1_700_000_000_000,
    });
    expect(normalizeSchedule({ type: "once", date: "2026-09-01", time: "09:00" })).toEqual({
      type: "once",
      date: "2026-09-01",
      time: "09:00",
    });
    expect(normalizeSchedule({ type: "monthly", day: 15, time: "10:30" })).toEqual({
      type: "monthly",
      day: 15,
      time: "10:30",
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
    expect(() => normalizeSchedule({ type: "interval", intervalMinutes: 1.5, anchorAt: 0 }))
      .toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "interval", intervalMinutes: Number.MAX_SAFE_INTEGER, anchorAt: 0 }))
      .toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "interval", intervalMinutes: 1, anchorAt: Number.MAX_SAFE_INTEGER }))
      .toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "monthly", day: 0, time: "09:00" })).toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "monthly", day: 32, time: "09:00" })).toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "once", date: "2026-02-30", time: "09:00" })).toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "once", date: "2026/09/01", time: "09:00" })).toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({
      type: "once",
      afterMinutes: 1,
      anchorAt: 0,
      date: "2026-09-01",
      time: "09:00",
    } as never)).toThrow(ScheduleValidationError);
  });

  it("keeps interval occurrences at fixed minute intervals", () => {
    const anchor = Date.parse("2026-01-01T00:00:00.000Z");
    expect(calculateNextRunAt({ type: "interval", intervalMinutes: 180, anchorAt: anchor }, "UTC", anchor))
      .toBe(anchor + 180 * 60_000);
    expect(calculateNextRunAt({ type: "interval", intervalMinutes: 90, anchorAt: anchor }, "UTC", anchor))
      .toBe(anchor + 90 * 60_000);
    expect(calculateNextRunAt({ type: "interval", intervalMinutes: 30, anchorAt: anchor }, "UTC", anchor))
      .toBe(anchor + 30 * 60_000);
  });

  it("runs a once schedule at its target instant and ends afterwards", () => {
    const before = Date.parse("2026-09-01T08:00:00.000Z");
    const at = Date.parse("2026-09-01T09:00:00.000Z");
    expect(calculateNextRunAt({ type: "once", date: "2026-09-01", time: "09:00" }, "UTC", before)).toBe(at);
    expect(calculateNextRunAt({ type: "once", date: "2026-09-01", time: "09:00" }, "UTC", at)).toBeNull();
    expect(calculateNextRunAt({ type: "once", date: "2026-09-01", time: "09:00" }, "UTC", at + 1)).toBeNull();
  });

  it("normalizes and calculates a relative once schedule from its anchor", () => {
    const anchor = Date.parse("2026-09-01T09:00:00.000Z");
    const relative = { type: "once" as const, afterMinutes: 1, anchorAt: anchor };
    expect(normalizeSchedule(relative)).toEqual(relative);
    expect(calculateNextRunAt(relative, "UTC", anchor - 1)).toBe(anchor + 60_000);
    expect(calculateNextRunAt(relative, "UTC", anchor + 60_000)).toBeNull();
    expect(calculateNextRunAt(relative, "UTC", anchor + 60_000 + 1)).toBeNull();
    expect(() => normalizeSchedule({ type: "once", afterMinutes: 0, anchorAt: anchor }))
      .toThrow(ScheduleValidationError);
    expect(() => normalizeSchedule({ type: "once", afterMinutes: 1, anchorAt: 1.5 }))
      .toThrow(ScheduleValidationError);
  });

  it("rejects a once schedule whose local instant does not exist", () => {
    // 2026-03-08 02:30 does not exist in America/New_York (DST spring gap).
    expect(() => calculateNextRunAt(
      { type: "once", date: "2026-03-08", time: "02:30" },
      "America/New_York",
      Date.parse("2026-03-01T00:00:00.000Z"),
    )).toThrow(ScheduleValidationError);
  });

  it("finds the next monthly occurrence and skips months without that day", () => {
    const afterJan = Date.parse("2026-01-15T00:00:00.000Z");
    expect(calculateNextRunAt({ type: "monthly", day: 1, time: "09:00" }, "UTC", afterJan))
      .toBe(Date.parse("2026-02-01T09:00:00.000Z"));
    // February has no 31st, so the next occurrence is March 31.
    const afterFeb = Date.parse("2026-02-01T00:00:00.000Z");
    expect(calculateNextRunAt({ type: "monthly", day: 31, time: "09:00" }, "UTC", afterFeb))
      .toBe(Date.parse("2026-03-31T09:00:00.000Z"));
    // 2026 is not a leap year; 2026-02-29 does not exist, so February is skipped.
    const afterLeap = Date.parse("2026-01-30T00:00:00.000Z");
    expect(calculateNextRunAt({ type: "monthly", day: 29, time: "09:00" }, "UTC", afterLeap))
      .toBe(Date.parse("2026-03-29T09:00:00.000Z"));
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
