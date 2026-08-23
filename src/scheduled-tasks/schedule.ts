import {
  scheduleWeekdays,
  type Schedule,
  type ScheduleWeekday,
} from "./types.js";

const hourMs = 60 * 60_000;
const dayMs = 24 * hourMs;
const maxCalendarSearchDays = 370;
const maxDateMs = 8_640_000_000_000_000;
const maxHourlyIntervalHours = Math.floor(maxDateMs / hourMs);
/** A bounded set of points around the requested local date. */
const offsetProbeHours = [
  -72, -48, -36, -24, -12, -6, -3, -1,
  0,
  1, 3, 6, 12, 24, 36, 48, 72,
] as const;
const weekdayByIntlIndex: readonly ScheduleWeekday[] = [
  "SU",
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
];

export class ScheduleValidationError extends Error {
  readonly code = "scheduled-task.schedule.invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export function isValidIanaTimeZone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateIanaTimeZone(timezone: unknown): string {
  const normalized = typeof timezone === "string" ? timezone.trim() : "";
  if (!isValidIanaTimeZone(normalized)) {
    throw new ScheduleValidationError(`无效的 IANA 时区：${String(timezone)}`);
  }
  return normalized;
}

export function normalizeSchedule(schedule: Schedule): Schedule {
  if (!isRecord(schedule) || typeof schedule.type !== "string") {
    throw new ScheduleValidationError("Schedule 类型无效");
  }
  switch (schedule.type) {
    case "hourly": {
      if (!Number.isSafeInteger(schedule.intervalHours) || schedule.intervalHours < 1) {
        throw new ScheduleValidationError("Hourly intervalHours 必须是正整数");
      }
      if (schedule.intervalHours > maxHourlyIntervalHours) {
        throw new ScheduleValidationError("Hourly intervalHours 超出可表示的时间范围");
      }
      const intervalMs = schedule.intervalHours * hourMs;
      if (!Number.isSafeInteger(intervalMs) || intervalMs > maxDateMs) {
        throw new ScheduleValidationError("Hourly intervalHours 超出可表示的时间范围");
      }
      validateEpochMilliseconds(schedule.anchorAt, "Hourly anchorAt");
      return Object.freeze({
        type: "hourly",
        intervalHours: schedule.intervalHours,
        anchorAt: schedule.anchorAt,
      });
    }
    case "daily":
      return Object.freeze({ type: "daily", time: normalizeLocalTime(schedule.time) });
    case "weekdays":
      return Object.freeze({ type: "weekdays", time: normalizeLocalTime(schedule.time) });
    case "weekly": {
      const days = normalizeWeekdays(schedule.days);
      return Object.freeze({
        type: "weekly",
        days: Object.freeze(days),
        time: normalizeLocalTime(schedule.time),
      });
    }
    default:
      throw new ScheduleValidationError(`不支持的 Schedule 类型：${String(schedule)}`);
  }
}

export function validateSchedule(schedule: Schedule, timezone: string): Schedule {
  validateIanaTimeZone(timezone);
  return normalizeSchedule(schedule);
}

/**
 * Return the next occurrence strictly after `afterMs`.
 *
 * Local schedules are resolved by probing a bounded set of nearby UTC
 * instants for the timezone's possible offsets, then validating the resulting
 * candidates with formatted local components.  That intentionally handles
 * both DST gaps (no matching instant, so the occurrence is skipped) and folds
 * (two matching instants, of which the earlier one is selected).  It also
 * avoids depending on the host process TZ or on undocumented offset
 * arithmetic.
 */
export function calculateNextRunAt(
  schedule: Schedule,
  timezone: string,
  afterMs: number,
): number {
  validateEpochMilliseconds(afterMs, "计算 nextRunAt");
  const normalizedTimezone = validateIanaTimeZone(timezone);
  const normalized = normalizeSchedule(schedule);
  if (normalized.type === "hourly") {
    return nextHourlyOccurrence(normalized, afterMs);
  }

  const local = localDateParts(afterMs, normalizedTimezone);
  const requestedTime = parseLocalTime(normalized.time);
  const allowedDays = normalized.type === "daily"
    ? null
    : normalized.type === "weekdays"
      ? new Set<ScheduleWeekday>(["MO", "TU", "WE", "TH", "FR"])
      : new Set(normalized.days);
  let date = datePartsToUtcDay(local.year, local.month, local.day);

  for (let day = 0; day <= maxCalendarSearchDays; day += 1) {
    if (date < -maxDateMs || date > maxDateMs) {
      throw new ScheduleValidationError("日历日期超出可表示的时间范围");
    }
    const dateParts = utcDayToDateParts(date);
    const weekday = weekdayForUtcDay(date);
    if (allowedDays === null || allowedDays.has(weekday)) {
      const candidates = localDateTimeToUtcCandidates(
        normalizedTimezone,
        dateParts,
        requestedTime.hour,
        requestedTime.minute,
      );
      // candidates is sorted and selecting the first candidate is deliberate:
      // a repeated local time executes only once, at the earlier instant.
      const candidate = candidates[0];
      if (candidate !== undefined && candidate > afterMs) return candidate;
    }
    date += dayMs;
  }
  throw new ScheduleValidationError("无法在一年内计算下一次 Schedule occurrence");
}

export function normalizeLocalTime(time: string): string {
  const normalized = typeof time === "string" ? time.trim() : "";
  const parsed = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(normalized);
  if (!parsed) {
    throw new ScheduleValidationError(`本地时间必须使用 HH:mm：${String(time)}`);
  }
  return normalized;
}

export function normalizeWeekdays(days: readonly ScheduleWeekday[]): ScheduleWeekday[] {
  if (!Array.isArray(days) || days.length === 0) {
    throw new ScheduleValidationError("Weekly days 不能为空");
  }
  const seen = new Set<string>();
  for (const rawDay of days as readonly unknown[]) {
    if (!isScheduleWeekday(rawDay) || seen.has(rawDay)) {
      throw new ScheduleValidationError(`Weekly weekday 无效或重复：${String(rawDay)}`);
    }
    seen.add(rawDay);
  }
  return scheduleWeekdays.filter((day) => seen.has(day));
}

export function parseLocalTime(time: string): { readonly hour: number; readonly minute: number } {
  const normalized = normalizeLocalTime(time);
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(normalized);
  // normalizeLocalTime guarantees this branch is unreachable, but keeping the
  // explicit guard makes the function total if it is changed independently.
  if (!match) throw new ScheduleValidationError("本地时间无效");
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

interface LocalDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

interface CalendarDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function nextHourlyOccurrence(
  schedule: Extract<Schedule, { readonly type: "hourly" }>,
  afterMs: number,
): number {
  const intervalMs = schedule.intervalHours * hourMs;
  if (!Number.isSafeInteger(intervalMs) || intervalMs > maxDateMs) {
    throw new ScheduleValidationError("Hourly intervalHours 超出可表示的时间范围");
  }
  if (afterMs < schedule.anchorAt) return schedule.anchorAt;
  const elapsed = BigInt(afterMs) - BigInt(schedule.anchorAt);
  const steps = elapsed / BigInt(intervalMs) + 1n;
  const candidate = BigInt(schedule.anchorAt) + steps * BigInt(intervalMs);
  if (candidate < BigInt(-maxDateMs) || candidate > BigInt(maxDateMs)) {
    throw new ScheduleValidationError("Hourly Schedule 超出可表示的时间范围");
  }
  return Number(candidate);
}

function localDateParts(timestampMs: number, timezone: string): LocalDateParts {
  const parts = getFormatter(timezone).formatToParts(new Date(timestampMs));
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  const second = values.get("second");
  if ([year, month, day, hour, minute, second].some((value) => value === undefined || !Number.isFinite(value))) {
    throw new ScheduleValidationError("无法解析 IANA 时区本地时间");
  }
  return {
    year: year!,
    month: month!,
    day: day!,
    hour: hour!,
    minute: minute!,
    second: second!,
  };
}

function localDateTimeToUtcCandidates(
  timezone: string,
  date: CalendarDateParts,
  hour: number,
  minute: number,
): number[] {
  const naiveUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  if (!Number.isFinite(naiveUtc) || naiveUtc < -maxDateMs || naiveUtc > maxDateMs) {
    throw new ScheduleValidationError("日历日期超出可表示的时间范围");
  }
  const offsets = new Set<number>();
  for (const probeHours of offsetProbeHours) {
    const probe = naiveUtc + probeHours * hourMs;
    if (probe < -maxDateMs || probe > maxDateMs) continue;
    const local = localDateParts(probe, timezone);
    const localEpoch = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const utcEpoch = Math.trunc(probe / 1_000) * 1_000;
    const offset = localEpoch - utcEpoch;
    if (Number.isSafeInteger(offset)) offsets.add(offset);
  }
  const matches: number[] = [];
  for (const offset of offsets) {
    const timestamp = naiveUtc - offset;
    if (timestamp < -maxDateMs || timestamp > maxDateMs) continue;
    const local = localDateParts(timestamp, timezone);
    if (
      local.year === date.year
      && local.month === date.month
      && local.day === date.day
      && local.hour === hour
      && local.minute === minute
      && local.second === 0
    ) {
      matches.push(timestamp);
    }
  }
  return [...new Set(matches)].sort((left, right) => left - right);
}

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

function datePartsToUtcDay(year: number, month: number, day: number): number {
  const date = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(date) || date < -maxDateMs || date > maxDateMs) {
    throw new ScheduleValidationError("日历日期超出可表示的时间范围");
  }
  return date;
}

function utcDayToDateParts(timestampMs: number): CalendarDateParts {
  const value = new Date(timestampMs);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function weekdayForUtcDay(timestampMs: number): ScheduleWeekday {
  return weekdayByIntlIndex[new Date(timestampMs).getUTCDay()]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScheduleWeekday(value: unknown): value is ScheduleWeekday {
  return typeof value === "string" && (scheduleWeekdays as readonly string[]).includes(value);
}

function validateEpochMilliseconds(value: unknown, label: string): asserts value is number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < -maxDateMs
    || (value as number) > maxDateMs
  ) {
    throw new ScheduleValidationError(`${label} 必须是 JS Date 可表示范围内的安全整数 UTC epoch 毫秒`);
  }
}
