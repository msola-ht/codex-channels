export type PricingBucket = "peak" | "off-peak";

export const pricingBucketOrder: ReadonlyArray<PricingBucket> = [
  "off-peak",
  "peak",
];

export interface LocalMinuteRange {
  start: number;
  end: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

export function localMinuteOf(date: Date, timezone: string): number {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find(({ type }) => type === "hour")?.value);
  const minute = Number(parts.find(({ type }) => type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error("峰谷时段时区无法转换");
  }
  return hour * 60 + minute;
}

export function isMinuteInLocalRanges(
  minute: number,
  ranges: readonly LocalMinuteRange[],
): boolean {
  return ranges.some(({ start, end }) => minute >= start && minute < end);
}

export function isLocalWeekend(date: Date, timezone: string): boolean {
  let formatter = weekdayFormatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    });
    weekdayFormatters.set(timezone, formatter);
  }
  const weekday = formatter.format(date);
  return weekday === "Sat" || weekday === "Sun";
}
