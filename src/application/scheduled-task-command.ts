import { UserFacingError } from "../conversation-core/index.js";
import {
  scheduleWeekdays,
  validateIanaTimeZone,
  type ScheduleWeekday,
} from "../scheduled-tasks/index.js";
import type { ScheduledTaskCreateRequest } from "./scheduled-task-service.js";

export const scheduledTaskCommandUsageText = [
  "/schedule <自然语言描述（必须明确时区）>；固定句式可直接创建预览：N 分钟后 / 每 N 分钟 / 每天 HH:mm / 每月 N 号 HH:mm / 每周 DAYS HH:mm",
  "/schedule add interval <N>m|h <时区> <文本>",
  "/schedule add once <YYYY-MM-DD> <HH:mm> <时区> <文本>",
  "/schedule add monthly <1-31> <HH:mm> <时区> <文本>",
  "/schedule add daily <HH:mm> <时区> <文本>",
  "/schedule add weekdays <HH:mm> <时区> <文本>",
  "/schedule add weekly <MO,TU,...> <HH:mm> <时区> <文本>",
  "/schedule list [页码]",
  "/schedule runs <任务 ID 或列表序号> [页码]",
  "/schedule rename <任务 ID 或列表序号> <名称>",
  "/schedule pause|resume|run|delete <任务 ID 或列表序号>",
  "/schedule retry <Run ID 或列表序号>",
  "/schedule confirm <一次性令牌>",
].join("\n");

export type ScheduledTaskCommandOperation =
  | { readonly type: "natural"; readonly description: string }
  | { readonly type: "create"; readonly request: ScheduledTaskCreateRequest }
  | { readonly type: "list"; readonly page: number }
  | { readonly type: "runs"; readonly selector: string; readonly page: number }
  | { readonly type: "rename"; readonly selector: string; readonly name: string }
  | { readonly type: "pause" | "resume" | "run" | "delete"; readonly selector: string }
  | { readonly type: "retry"; readonly selector: string }
  | { readonly type: "confirm"; readonly token: string };

export function parseScheduledTaskOperation(
  input: string,
  nowMs = Date.now(),
): ScheduledTaskCommandOperation {
  const normalized = input.trim();
  if (!normalized) return { type: "list", page: 1 };
  const [command] = normalized.split(/\s+/u, 1);
  const remainder = normalized.slice(command!.length).trim();
  switch (command) {
    case "list":
      return { type: "list", page: parseOptionalPage(remainder) };
    case "runs": {
      const match = /^(\S+)(?:\s+([1-9]\d*))?$/u.exec(remainder);
      if (!match) return invalid();
      return { type: "runs", selector: match[1]!, page: Number(match[2] ?? "1") };
    }
    case "rename": {
      const match = /^(\S+)\s+([\s\S]+)$/u.exec(remainder);
      if (!match) return invalid();
      return { type: "rename", selector: match[1]!, name: match[2]! };
    }
    case "pause":
    case "resume":
    case "run":
    case "delete":
      if (!/^\S+$/u.test(remainder)) return invalid();
      return { type: command, selector: remainder };
    case "retry":
      if (!/^\S+$/u.test(remainder)) return invalid();
      return { type: "retry", selector: remainder };
    case "confirm":
      if (!/^[0-9a-f-]{36}$/iu.test(remainder)) return invalid();
      return { type: "confirm", token: remainder };
    case "add":
      return parseCreate(remainder, nowMs);
    default:
      return { type: "natural", description: normalized };
  }
}

export function parseNaturalScheduledTaskDraft(
  description: string,
  nowMs = Date.now(),
): ScheduledTaskCreateRequest | null {
  const input = description.trim();
  if (!input) return null;

  const interval = /^每\s*(\d+)\s*(分钟|小时)\s*(?:在\s*)?(\S+)\s+([\s\S]+)$/u.exec(input);
  if (interval) {
    const minutes = intervalMinutes(interval[1]!, interval[2]!);
    const timezone = ianaTimezone(interval[3]!);
    if (minutes === null || timezone === null) return null;
    return {
      schedule: { type: "interval", intervalMinutes: minutes, anchorAt: nowMs },
      timezone,
      prompt: interval[4]!.trim(),
    };
  }

  const relativeOnce = /^(\d+)\s*(分钟|小时)(?:后|之后)?\s*(?:在\s*)?(\S+)\s+([\s\S]+)$/u.exec(input);
  if (relativeOnce) {
    const minutes = intervalMinutes(relativeOnce[1]!, relativeOnce[2]!);
    const timezone = ianaTimezone(relativeOnce[3]!);
    if (minutes === null || timezone === null) return null;
    return {
      schedule: { type: "once", afterMinutes: minutes, anchorAt: nowMs },
      timezone,
      prompt: relativeOnce[4]!.trim(),
    };
  }

  const absoluteOnce =
    /^(\d{4}-\d{2}-\d{2})\s*(?:在\s*)?((?:[01]\d|2[0-3]):[0-5]\d)\s*(?:在\s*)?(\S+)\s+([\s\S]+)$/u.exec(input);
  if (absoluteOnce) {
    const timezone = ianaTimezone(absoluteOnce[3]!);
    if (timezone === null) return null;
    return {
      schedule: { type: "once", date: absoluteOnce[1]!, time: absoluteOnce[2]! },
      timezone,
      prompt: absoluteOnce[4]!.trim(),
    };
  }

  const daily = /^每天\s*(?:在\s*)?((?:[01]\d|2[0-3]):[0-5]\d)\s*(?:在\s*)?(\S+)\s+([\s\S]+)$/u.exec(input);
  if (daily) {
    const timezone = ianaTimezone(daily[2]!);
    if (timezone === null) return null;
    return {
      schedule: { type: "daily", time: daily[1]! },
      timezone,
      prompt: daily[3]!.trim(),
    };
  }

  const weekdays = /^工作日\s*(?:在\s*)?((?:[01]\d|2[0-3]):[0-5]\d)\s*(?:在\s*)?(\S+)\s+([\s\S]+)$/u.exec(input);
  if (weekdays) {
    const timezone = ianaTimezone(weekdays[2]!);
    if (timezone === null) return null;
    return {
      schedule: { type: "weekdays", time: weekdays[1]! },
      timezone,
      prompt: weekdays[3]!.trim(),
    };
  }

  const monthly =
    /^每月\s*(\d{1,2})\s*号\s*(?:在\s*)?((?:[01]\d|2[0-3]):[0-5]\d)\s*(?:在\s*)?(\S+)\s+([\s\S]+)$/u.exec(input);
  if (monthly) {
    const day = Number(monthly[1]!);
    const timezone = ianaTimezone(monthly[3]!);
    if (!Number.isInteger(day) || day < 1 || day > 31 || timezone === null) return null;
    return {
      schedule: { type: "monthly", day, time: monthly[2]! },
      timezone,
      prompt: monthly[4]!.trim(),
    };
  }

  const weekly =
    /^每周\s*([A-Za-z]{2}(?:,[A-Za-z]{2})*)\s*(?:在\s*)?((?:[01]\d|2[0-3]):[0-5]\d)\s*(?:在\s*)?(\S+)\s+([\s\S]+)$/u.exec(input);
  if (weekly) {
    const days = weekly[1]!.split(",").map((day) => day.toUpperCase());
    const timezone = ianaTimezone(weekly[3]!);
    if (
      days.some((day) => !scheduleWeekdays.includes(day as ScheduleWeekday))
      || timezone === null
    ) {
      return null;
    }
    return {
      schedule: {
        type: "weekly",
        days: days as ScheduleWeekday[],
        time: weekly[2]!,
      },
      timezone,
      prompt: weekly[4]!.trim(),
    };
  }

  return null;
}

function intervalMinutes(amountText: string, unit: string): number | null {
  const amount = Number(amountText);
  const minutes = unit === "小时" ? amount * 60 : amount;
  if (!Number.isSafeInteger(amount) || amount < 1 || !Number.isSafeInteger(minutes)) {
    return null;
  }
  return minutes;
}

function ianaTimezone(value: string): string | null {
  try {
    return validateIanaTimeZone(value);
  } catch {
    return null;
  }
}

function parseCreate(input: string, nowMs: number): ScheduledTaskCommandOperation {
  const [kind] = input.split(/\s+/u, 1);
  const remainder = input.slice(kind?.length ?? 0).trim();
  if (kind === "interval") {
    const match = /^(\d+)(m|min|h)?\s+(\S+)\s+([\s\S]+)$/ui.exec(remainder);
    if (!match) return invalid();
    const amount = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    if (!Number.isSafeInteger(amount) || amount < 1) return invalid();
    const intervalMinutes = unit === "h" ? amount * 60 : amount;
    return {
      type: "create",
      request: {
        schedule: { type: "interval", intervalMinutes, anchorAt: nowMs },
        timezone: match[3]!,
        prompt: match[4]!,
      },
    };
  }
  if (kind === "once") {
    const match = /^(\d{4}-\d{2}-\d{2})\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(remainder);
    if (!match) return invalid();
    return {
      type: "create",
      request: {
        schedule: { type: "once", date: match[1]!, time: match[2]! },
        timezone: match[3]!,
        prompt: match[4]!,
      },
    };
  }
  if (kind === "monthly") {
    const match = /^(\d{1,2})\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(remainder);
    if (!match) return invalid();
    const day = Number(match[1]);
    if (!Number.isSafeInteger(day) || day < 1 || day > 31) return invalid();
    return {
      type: "create",
      request: {
        schedule: { type: "monthly", day, time: match[2]! },
        timezone: match[3]!,
        prompt: match[4]!,
      },
    };
  }
  if (kind === "daily" || kind === "weekdays") {
    const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(remainder);
    if (!match) return invalid();
    return {
      type: "create",
      request: {
        schedule: { type: kind, time: match[1]! },
        timezone: match[2]!,
        prompt: match[3]!,
      },
    };
  }
  if (kind === "weekly") {
    const match = /^(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(remainder);
    if (!match) return invalid();
    const days = match[1]!.split(",").map((day) => day.toUpperCase());
    if (days.length === 0 || days.some((day) => !scheduleWeekdays.includes(day as ScheduleWeekday))) {
      return invalid();
    }
    return {
      type: "create",
      request: {
        schedule: { type: "weekly", days: days as ScheduleWeekday[], time: match[2]! },
        timezone: match[3]!,
        prompt: match[4]!,
      },
    };
  }
  return invalid();
}

function parseOptionalPage(value: string): number {
  if (!value) return 1;
  if (!/^[1-9]\d*$/u.test(value)) return invalid();
  return Number(value);
}

function invalid(): never {
  throw new UserFacingError(
    "scheduled-task.command.invalid",
    `Schedule 参数无效，用法：\n${scheduledTaskCommandUsageText}`,
  );
}
