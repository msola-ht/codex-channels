import { UserFacingError } from "../conversation-core/index.js";
import {
  scheduleWeekdays,
  ScheduleValidationError,
  validateIanaTimeZone,
  type Schedule,
  type ScheduledRun,
  type ScheduleWeekday,
} from "../scheduled-tasks/index.js";
import type {
  ScheduledTaskCreatePreview,
  ScheduledTaskDeletePreview,
  ScheduledTaskListResult,
  ScheduledTaskRunListResult,
  ScheduledTaskUseCases,
  ScheduledTaskView,
} from "./scheduled-task-service.js";

export const scheduledTaskToolName = "schedule_task";

export const scheduledTaskToolSpec = {
  type: "function",
  name: scheduledTaskToolName,
  description: [
    "管理 Gateway 计划任务。",
    "用户用日常语言描述计划时，由你提取 scheduleType、时区、提示词和规则字段。",
    "action=create 只创建确认预览，不会立即保存；必须把返回的确认令牌展示给用户，并提示回复 /schedule confirm <令牌>。",
    "确认必须由用户通过 /schedule confirm <令牌> 完成；你不得在工具内直接创建任务。",
    "model 为可选：可以是模型 ID，或 provider/model 复合串（如 deepseek/deepseek-v4-flash）；不传则使用当前会话的模型和 Provider。",
    "时间格式：intervalMinutes 为分钟数；afterMinutes 为一次性延后分钟数；date 使用 YYYY-MM-DD；time 使用 HH:mm；days 使用 MO/TU/WE/TH/FR/SA/SU。",
    "时区必须是 IANA 名称；用户说北京时间可转换为 Asia/Shanghai、纽约时间转换为 America/New_York。绝不猜测未提供的时区。",
  ].join(""),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: [
          "create",
          "list",
          "runs",
          "rename",
          "pause",
          "resume",
          "run",
          "retry",
          "delete",
        ],
      },
      scheduleType: {
        type: "string",
        enum: ["interval", "once", "monthly", "daily", "weekdays", "weekly"],
      },
      intervalMinutes: { type: "integer", minimum: 1, maximum: 525600 },
      afterMinutes: { type: "integer", minimum: 1, maximum: 525600 },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
      day: { type: "integer", minimum: 1, maximum: 31 },
      days: {
        type: "array",
        maxItems: 7,
        items: {
          type: "string",
          enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
        },
      },
      timezone: { type: "string", maxLength: 128 },
      prompt: { type: "string", maxLength: 20000 },
      model: { type: "string", maxLength: 128 },
      selector: { type: "string", maxLength: 256 },
      page: { type: "integer", minimum: 1, maximum: 100 },
      name: { type: "string", maxLength: 80 },
    },
    required: ["action"],
  },
} as const;

export type ScheduledTaskToolTaskOutcome = {
  action: "created" | "deleted" | "renamed" | "paused" | "resumed";
  task: ScheduledTaskView;
};

export type ScheduledTaskToolRunOutcome = {
  action: "run-requested" | "retry-requested";
  run: ScheduledRun;
};

export type ScheduledTaskToolResult =
  | {
      kind: "confirmation";
      preview: ScheduledTaskCreatePreview | ScheduledTaskDeletePreview;
    }
  | { kind: "tasks"; result: ScheduledTaskListResult }
  | { kind: "runs"; result: ScheduledTaskRunListResult }
  | { kind: "outcome"; outcome: ScheduledTaskToolTaskOutcome | ScheduledTaskToolRunOutcome }
  | { kind: "error"; message: string };

export class ScheduledTaskToolService {
  constructor(
    private readonly tasks: ScheduledTaskUseCases,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(
    target: Parameters<ScheduledTaskUseCases["list"]>[0],
    actorId: string,
    args: unknown,
  ): Promise<ScheduledTaskToolResult> {
    try {
      const request = parseToolRequest(args, this.now());
      switch (request.action) {
        case "create":
          return {
            kind: "confirmation",
            preview: this.tasks.previewCreate(target, actorId, {
              schedule: request.schedule,
              timezone: request.timezone,
              prompt: request.prompt,
              ...(request.model === undefined ? {} : { model: request.model }),
            }),
          };
        case "list":
          return { kind: "tasks", result: this.tasks.list(target, actorId, request.page) };
        case "runs":
          return {
            kind: "runs",
            result: this.tasks.runs(target, actorId, request.selector, request.page),
          };
        case "rename":
          return outcome(
            "renamed",
            this.tasks.rename(target, actorId, request.selector, request.name),
          );
        case "pause":
          return outcome("paused", this.tasks.pause(target, actorId, request.selector));
        case "resume":
          return outcome("resumed", this.tasks.resume(target, actorId, request.selector));
        case "run":
          return { kind: "outcome", outcome: { action: "run-requested", run: await this.tasks.run(target, actorId, request.selector) } };
        case "retry":
          return { kind: "outcome", outcome: { action: "retry-requested", run: await this.tasks.retry(target, actorId, request.selector) } };
        case "delete":
          return {
            kind: "confirmation",
            preview: this.tasks.previewDelete(target, actorId, request.selector),
          };
      }
    } catch (error) {
      return { kind: "error", message: toolErrorMessage(error) };
    }
  }
}

type ToolRequest =
  | {
      action: "create";
      schedule: Schedule;
      timezone: string;
      prompt: string;
      model?: string;
    }
  | { action: "list"; page: number }
  | { action: "runs"; selector: string; page: number }
  | { action: "rename"; selector: string; name: string }
  | { action: "pause" | "resume" | "run" | "retry" | "delete"; selector: string };

function parseToolRequest(args: unknown, nowMs: number): ToolRequest {
  const value = asRecord(args);
  const action = requiredString(value.action, "action");
  switch (action) {
    case "create":
      return parseCreate(value, nowMs);
    case "list":
      return { action, page: optionalPage(value.page) };
    case "runs":
      return {
        action,
        selector: requiredString(value.selector, "selector"),
        page: optionalPage(value.page),
      };
    case "rename":
      return {
        action,
        selector: requiredString(value.selector, "selector"),
        name: requiredString(value.name, "name"),
      };
    case "pause":
    case "resume":
    case "run":
    case "retry":
    case "delete":
      return { action, selector: requiredString(value.selector, "selector") };
    default:
      throw toolError(`不支持的 schedule_task action：${action}`);
  }
}

function parseCreate(
  value: Record<string, unknown>,
  nowMs: number,
): { action: "create" } & ToolRequest {
  const scheduleType = requiredString(value.scheduleType, "scheduleType");
  const timezone = validateIanaTimeZone(requiredString(value.timezone, "timezone"));
  const prompt = requiredString(value.prompt, "prompt").trim();
  if (!prompt) throw toolError("计划任务内容不能为空");
  const model = optionalString(value.model);

  switch (scheduleType) {
    case "interval": {
      const intervalMinutes = requiredInteger(value.intervalMinutes, "intervalMinutes");
      return {
        action: "create",
        schedule: { type: "interval", intervalMinutes, anchorAt: nowMs },
        timezone,
        prompt,
        ...(model === undefined ? {} : { model }),
      };
    }
    case "once": {
      const date = optionalString(value.date);
      const time = optionalString(value.time);
      const afterMinutes = optionalInteger(value.afterMinutes);
      if ((date !== undefined || time !== undefined) && afterMinutes !== null) {
        throw toolError("一次性任务不能同时使用 date/time 和 afterMinutes");
      }
      if (date && time) {
        return {
          action: "create",
          schedule: { type: "once", date, time },
          timezone,
          prompt,
          ...(model === undefined ? {} : { model }),
        };
      }
      if (afterMinutes !== null) {
        return {
          action: "create",
          schedule: { type: "once", afterMinutes, anchorAt: nowMs },
          timezone,
          prompt,
          ...(model === undefined ? {} : { model }),
        };
      }
      throw toolError("一次性任务需要 date+time 或 afterMinutes");
    }
    case "monthly": {
      const day = requiredInteger(value.day, "day");
      const time = requiredString(value.time, "time");
      return {
        action: "create",
        schedule: { type: "monthly", day, time },
        timezone,
        prompt,
        ...(model === undefined ? {} : { model }),
      };
    }
    case "daily":
    case "weekdays": {
      const time = requiredString(value.time, "time");
      return {
        action: "create",
        schedule: { type: scheduleType, time },
        timezone,
        prompt,
        ...(model === undefined ? {} : { model }),
      };
    }
    case "weekly": {
      const days = parseDays(value.days);
      const time = requiredString(value.time, "time");
      return {
        action: "create",
        schedule: { type: "weekly", days, time },
        timezone,
        prompt,
        ...(model === undefined ? {} : { model }),
      };
    }
    default:
      throw toolError(`不支持的 scheduleType：${scheduleType}`);
  }
}

function parseDays(value: unknown): ScheduleWeekday[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw toolError("weekly 需要至少一个星期字段");
  }
  const days = value.map((entry) => requiredString(entry, "days[]").toUpperCase());
  if (days.some((day) => !scheduleWeekdays.includes(day as ScheduleWeekday))) {
    throw toolError("weekly days 只支持 MO/TU/WE/TH/FR/SA/SU");
  }
  return days as ScheduleWeekday[];
}

function outcome(
  action: ScheduledTaskToolTaskOutcome["action"],
  task: ScheduledTaskView,
): ScheduledTaskToolResult {
  return { kind: "outcome", outcome: { action, task } };
}

function optionalPage(value: unknown): number {
  if (value === undefined) return 1;
  const page = requiredInteger(value, "page");
  if (page < 1 || page > 100) throw toolError("page 必须在 1 到 100 之间");
  return page;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, "string");
}

function optionalInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return requiredInteger(value, "integer");
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw toolError(`${field} 必须是整数`);
    return value;
  }
  if (typeof value !== "string" || !/^-?\d+$/u.test(value)) {
    throw toolError(`${field} 必须是整数`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw toolError(`${field} 超出安全整数范围`);
  return number;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw toolError(`${field} 不能为空`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw toolError("schedule_task 参数必须是对象");
  }
  return value as Record<string, unknown>;
}

function toolError(message: string): UserFacingError {
  return new UserFacingError("scheduled-task.command.invalid", message);
}

function toolErrorMessage(error: unknown): string {
  return error instanceof UserFacingError || error instanceof ScheduleValidationError
    ? error.message
    : "计划任务工具执行失败，请稍后重试";
}
