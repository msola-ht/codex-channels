import { UserFacingError } from "../conversation-core/index.js";
import { scheduleWeekdays, type ScheduleWeekday } from "../scheduled-tasks/index.js";
import type { ScheduledTaskCreateRequest } from "./scheduled-task-service.js";

export const scheduledTaskCommandUsageText = [
  "/schedule <自然语言描述（必须明确时区）>",
  "/schedule add hourly <小时数> <时区> <文本>",
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

function parseCreate(input: string, nowMs: number): ScheduledTaskCommandOperation {
  const [kind] = input.split(/\s+/u, 1);
  const remainder = input.slice(kind?.length ?? 0).trim();
  if (kind === "hourly") {
    const match = /^([1-9]\d*)\s+(\S+)\s+([\s\S]+)$/u.exec(remainder);
    if (!match) return invalid();
    const intervalHours = Number(match[1]);
    if (!Number.isSafeInteger(intervalHours)) return invalid();
    return {
      type: "create",
      request: {
        schedule: { type: "hourly", intervalHours, anchorAt: nowMs },
        timezone: match[2]!,
        prompt: match[3]!,
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
