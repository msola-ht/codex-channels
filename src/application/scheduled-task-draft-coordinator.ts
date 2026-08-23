import {
  UserFacingError,
  conversationTargetKey,
  type ConversationInputEvent,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { Schedule, ScheduleWeekday } from "../scheduled-tasks/index.js";
import type { ScheduledTaskCreateRequest } from "./scheduled-task-service.js";
import type { TurnOutputSchema } from "./turn-port.js";

const draftTimeoutMs = 90_000;
const maximumDrafts = 64;

export interface ScheduledTaskDraftExecutionContext {
  readonly cwd: string;
  readonly modelProvider: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
}

export interface ScheduledTaskDraftTurnPort {
  start(
    context: ScheduledTaskDraftExecutionContext,
    text: string,
    outputSchema: TurnOutputSchema,
    onThreadStarted: (threadId: string) => boolean,
  ): Promise<{ threadId: string; turnId: string }>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  release(threadId: string): Promise<void>;
}

interface PendingDraft {
  readonly key: string;
  readonly resolve: (request: ScheduledTaskCreateRequest) => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  threadId?: string;
  turnId?: string;
  output?: string;
  settled: boolean;
}

export class ScheduledTaskDraftCoordinator {
  private readonly pendingByConversation = new Map<string, PendingDraft>();
  private readonly pendingByThread = new Map<string, PendingDraft>();

  constructor(
    private readonly turns: ScheduledTaskDraftTurnPort,
    private readonly timeoutMs = draftTimeoutMs,
  ) {}

  draft(
    target: ConversationTarget,
    _actorId: string,
    description: string,
    context: ScheduledTaskDraftExecutionContext,
  ): Promise<ScheduledTaskCreateRequest> {
    const key = conversationTargetKey(target);
    if (this.pendingByConversation.has(key)) {
      throw draftError("当前会话已有计划任务草案正在生成");
    }
    if (this.pendingByConversation.size >= maximumDrafts) {
      throw draftError("计划任务草案请求过多，请稍后重试");
    }
    let resolveDraft!: (value: ScheduledTaskCreateRequest) => void;
    let rejectDraft!: (reason: unknown) => void;
    const result = new Promise<ScheduledTaskCreateRequest>((resolve, reject) => {
      resolveDraft = resolve;
      rejectDraft = reject;
    });
    const pending: PendingDraft = {
      key,
      resolve: resolveDraft,
      reject: rejectDraft,
      settled: false,
    };
    pending.timer = setTimeout(() => {
        void this.finish(
          pending,
          { error: draftError("计划任务理解超时，请简化描述后重试") },
          true,
        );
      }, this.timeoutMs);
    pending.timer.unref();
    this.pendingByConversation.set(key, pending);
    void this.start(pending, context, description);
    return result;
  }

  handleInput(event: ConversationInputEvent): void {
    if (!("threadId" in event) || typeof event.threadId !== "string") return;
    const pending = this.pendingByThread.get(event.threadId);
    if (!pending || pending.settled) return;
    if ("turnId" in event && pending.turnId && event.turnId !== pending.turnId) return;
    if (event.type === "turn.started") {
      pending.turnId ??= event.turnId;
      return;
    }
    if (event.type === "item.agentMessage.completed") {
      pending.turnId ??= event.turnId;
      if (event.phase === "final_answer") pending.output = event.text;
      return;
    }
    if (event.type === "item.operation.updated" || event.type === "item.subagentActivity") {
      void this.finish(
        pending,
        { error: draftError("计划任务草案尝试使用工具，已安全取消") },
        true,
      );
      return;
    }
    if (event.type !== "turn.completed") return;
    pending.turnId ??= event.turnId;
    if (event.status !== "completed" || !pending.output) {
      void this.finish(pending, { error: draftError("计划任务草案生成失败，请重试") });
      return;
    }
    try {
      void this.finish(pending, { request: parseDraftOutput(pending.output) });
    } catch (error) {
      void this.finish(pending, { error });
    }
  }

  close(): void {
    for (const pending of [...this.pendingByConversation.values()]) {
      void this.finish(
        pending,
        { error: draftError("Gateway 正在停止，计划任务草案已取消") },
        true,
      );
    }
  }

  private async start(
    pending: PendingDraft,
    context: ScheduledTaskDraftExecutionContext,
    description: string,
  ): Promise<void> {
    try {
      const started = await this.turns.start(
        context,
        draftPrompt(description),
        scheduledTaskDraftOutputSchema,
        (threadId) => this.registerThread(pending, threadId),
      );
      if (pending.settled) {
        await this.releaseBestEffort(started.threadId);
        return;
      }
      if (pending.threadId !== started.threadId) {
        throw new Error("计划任务草案返回了不同的临时 Thread");
      }
      if (pending.turnId && pending.turnId !== started.turnId) {
        throw new Error("计划任务草案返回了不同的 Turn");
      }
      pending.turnId = started.turnId;
    } catch (error) {
      if (!pending.settled) await this.finish(pending, { error });
    }
  }

  private registerThread(pending: PendingDraft, threadId: string): boolean {
    if (pending.settled) {
      void this.releaseBestEffort(threadId);
      return false;
    }
    if (pending.threadId && pending.threadId !== threadId) return false;
    const existing = this.pendingByThread.get(threadId);
    if (existing && existing !== pending) return false;
    pending.threadId = threadId;
    this.pendingByThread.set(threadId, pending);
    return true;
  }

  private async finish(
    pending: PendingDraft,
    outcome: { request: ScheduledTaskCreateRequest } | { error: unknown },
    interrupt = false,
  ): Promise<void> {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    if (this.pendingByConversation.get(pending.key) === pending) {
      this.pendingByConversation.delete(pending.key);
    }
    if (pending.threadId && this.pendingByThread.get(pending.threadId) === pending) {
      this.pendingByThread.delete(pending.threadId);
    }
    if (interrupt && pending.threadId && pending.turnId) {
      await this.turns.interrupt(pending.threadId, pending.turnId).catch(() => undefined);
    }
    if (pending.threadId) await this.releaseBestEffort(pending.threadId);
    if ("request" in outcome) pending.resolve(outcome.request);
    else pending.reject(outcome.error);
  }

  private async releaseBestEffort(threadId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.turns.release(threadId);
        return;
      } catch {
        // Unsubscribe is idempotent; one bounded retry preserves auxiliary
        // Provider routing after a transient failure without blind looping.
      }
    }
  }
}

export const scheduledTaskDraftOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "prompt", "scheduleType", "intervalHours", "time", "days", "timezone", "missing"],
  properties: {
    kind: { type: "string", enum: ["draft", "clarification", "unsupported"] },
    prompt: { type: ["string", "null"], maxLength: 20_000 },
    scheduleType: { type: ["string", "null"], enum: ["hourly", "daily", "weekdays", "weekly", null] },
    intervalHours: { type: ["integer", "null"], minimum: 1, maximum: 8760 },
    time: { type: ["string", "null"], pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
    days: { type: "array", maxItems: 7, items: { type: "string", enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] } },
    timezone: { type: ["string", "null"], maxLength: 128 },
    missing: {
      type: "array",
      maxItems: 4,
      items: { type: "string", enum: ["schedule", "time", "timezone", "prompt"] },
    },
  },
} satisfies TurnOutputSchema;

function draftPrompt(description: string): string {
  return [
    "你只负责把下面的自然语言转换为 Gateway 计划任务草案。不要调用任何工具，不要执行任务，不要修改文件。",
    "只支持 hourly、daily、weekdays、weekly；不支持一次性、每月或更复杂日历规则。",
    "不要猜测时区；用户明确表达地区或时区时规范化为 IANA 名称，完全没有表达时区时返回 clarification。",
    "clarification 只填写 missing 枚举，不生成面向用户的自由文本。",
    "prompt 只保留任务执行内容，不包含时间表达。所有字段必须符合输出 Schema。",
    "用户描述 JSON：",
    JSON.stringify(description.trim()),
  ].join("\n");
}

function parseDraftOutput(text: string): ScheduledTaskCreateRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw draftError("模型返回了无效的计划任务草案，请重试");
  }
  if (!isRecord(value)) throw draftError("模型返回了无效的计划任务草案，请重试");
  if (value.kind === "clarification") throw clarificationError(value.missing);
  if (value.kind === "unsupported") {
    throw draftError("当前只支持每隔若干小时、每天、工作日和每周指定日期的计划任务");
  }
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const timezone = typeof value.timezone === "string" ? value.timezone.trim() : "";
  if (value.kind !== "draft" || !prompt || !timezone) {
    throw draftError("计划任务草案缺少任务内容或 IANA 时区");
  }
  let schedule: Schedule;
  if (value.scheduleType === "hourly" && Number.isSafeInteger(value.intervalHours)) {
    schedule = { type: "hourly", intervalHours: value.intervalHours as number, anchorAt: Date.now() };
  } else if ((value.scheduleType === "daily" || value.scheduleType === "weekdays") && typeof value.time === "string") {
    schedule = { type: value.scheduleType, time: value.time };
  } else if (value.scheduleType === "weekly" && typeof value.time === "string" && isWeekdays(value.days)) {
    schedule = { type: "weekly", time: value.time, days: value.days };
  } else {
    throw draftError("模型返回了不完整的计划规则，请重试");
  }
  return { schedule, timezone, prompt };
}

function clarificationError(value: unknown): UserFacingError {
  const missing = new Set(Array.isArray(value) ? value : []);
  if (missing.has("timezone")) {
    return draftError("请补充计划任务时区，例如 Asia/Shanghai 或北京时间");
  }
  if (missing.has("time") || missing.has("schedule")) {
    return draftError("请补充计划任务的执行频率和时间");
  }
  if (missing.has("prompt")) return draftError("请补充计划任务需要执行的内容");
  return draftError("请补充计划时间、时区或任务内容");
}

function isWeekdays(value: unknown): value is ScheduleWeekday[] {
  const allowed = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
  return Array.isArray(value) && value.length > 0
    && value.every((day) => typeof day === "string" && allowed.has(day));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function draftError(message: string): UserFacingError {
  return new UserFacingError("scheduled-task.command.invalid", message);
}
