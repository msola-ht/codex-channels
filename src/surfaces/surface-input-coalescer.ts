import type {
  ConversationInput,
  Submission,
} from "../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";

const DEFAULT_QUIET_WINDOW_MS = 1_000;
const DEFAULT_MAXIMUM_IMAGES = 4;
const DEFAULT_MAXIMUM_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_VISION_PROMPT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_PENDING_VISION_PROMPTS = 1_000;
const MAXIMUM_VISION_PROMPT_LENGTH = 4_000;

export interface SurfaceInputPart {
  target: ConversationTarget;
  actorId: string;
  sequence: number;
  text?: string;
  localImages?: ReadonlyArray<{ path: string; bytes?: number }>;
  aggregationKey?: string;
  aggregationSize?: number;
}

export interface SurfaceInputBatchResult {
  submission: Submission;
  tail: boolean;
}

export interface SurfaceInputCoalescerOptions {
  quietWindowMs?: number;
  maximumImages?: number;
  maximumImageBytes?: number;
  visionPromptTtlMs?: number;
  maximumPendingVisionPrompts?: number;
}

type SubmitConversationInput = (
  target: ConversationTarget,
  input: string | ConversationInput,
) => Promise<Submission>;

interface PendingPart extends SurfaceInputPart {
  order: number;
  resolve(result: SurfaceInputBatchResult): void;
  reject(error: unknown): void;
}

interface PendingBatch {
  target: ConversationTarget;
  actorKey: string;
  expectedParts?: number;
  parts: PendingPart[];
  timer: NodeJS.Timeout;
}

interface PendingVisionPrompt {
  prompt: string;
  timer: NodeJS.Timeout;
}

export class SurfaceInputCoalescer {
  private readonly quietWindowMs: number;
  private readonly maximumImages: number;
  private readonly maximumImageBytes: number;
  private readonly visionPromptTtlMs: number;
  private readonly maximumPendingVisionPrompts: number;
  private readonly pending = new Map<string, PendingBatch>();
  private readonly pendingVisionPrompts = new Map<string, PendingVisionPrompt>();
  private readonly inFlight = new Set<Promise<void>>();
  private nextOrder = 0;
  private closed = false;

  constructor(
    private readonly submit: SubmitConversationInput,
    options: SurfaceInputCoalescerOptions = {},
  ) {
    this.quietWindowMs = nonNegativeInteger(
      options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS,
      "输入聚合静默窗口无效",
    );
    this.maximumImages = positiveInteger(
      options.maximumImages ?? DEFAULT_MAXIMUM_IMAGES,
      "输入聚合图片上限无效",
    );
    this.maximumImageBytes = positiveInteger(
      options.maximumImageBytes ?? DEFAULT_MAXIMUM_IMAGE_BYTES,
      "输入聚合图片总大小上限无效",
    );
    this.visionPromptTtlMs = positiveInteger(
      options.visionPromptTtlMs ?? DEFAULT_VISION_PROMPT_TTL_MS,
      "图片识别要求有效期无效",
    );
    this.maximumPendingVisionPrompts = positiveInteger(
      options.maximumPendingVisionPrompts ?? DEFAULT_MAXIMUM_PENDING_VISION_PROMPTS,
      "待处理图片识别要求容量无效",
    );
  }

  setVisionPrompt(
    target: ConversationTarget,
    actorId: string,
    value: string,
  ): { replaced: boolean } {
    if (this.closed) throw new Error("输入聚合器已关闭");
    const prompt = value.trim();
    if (!prompt || prompt.length > MAXIMUM_VISION_PROMPT_LENGTH) {
      throw new UserFacingError(
        "vision.prompt.invalid",
        "图片识别要求必须为 1 至 4000 个字符",
      );
    }
    const key = batchKey(target, actorId);
    const previous = this.pendingVisionPrompts.get(key);
    if (
      previous === undefined
      && this.pendingVisionPrompts.size >= this.maximumPendingVisionPrompts
    ) {
      throw new UserFacingError(
        "vision.prompt.capacity",
        "待处理的图片识别要求已满",
      );
    }
    if (previous !== undefined) clearTimeout(previous.timer);
    const entry: PendingVisionPrompt = {
      prompt,
      timer: undefined as never,
    };
    entry.timer = setTimeout(() => {
      if (this.pendingVisionPrompts.get(key) === entry) {
        this.pendingVisionPrompts.delete(key);
      }
    }, this.visionPromptTtlMs);
    entry.timer.unref();
    this.pendingVisionPrompts.set(key, entry);
    return { replaced: previous !== undefined };
  }

  cancelVisionPrompt(target: ConversationTarget, actorId: string): boolean {
    const key = batchKey(target, actorId);
    const pending = this.pendingVisionPrompts.get(key);
    if (pending === undefined) return false;
    clearTimeout(pending.timer);
    this.pendingVisionPrompts.delete(key);
    return true;
  }

  enqueue(input: SurfaceInputPart): Promise<SurfaceInputBatchResult> {
    if (this.closed) {
      return Promise.reject(new Error("输入聚合器已关闭"));
    }
    const text = input.text?.trim();
    const localImages = input.localImages ?? [];
    if ((text === undefined || text.length === 0) && localImages.length === 0) {
      return Promise.reject(new Error("输入聚合内容为空"));
    }
    const actorKey = batchKey(input.target, input.actorId);
    const aggregationKey = input.aggregationKey?.trim();
    const key = aggregationKey
      ? `${actorKey}\u0000${aggregationKey}`
      : undefined;
    const aggregationSize = key === undefined || input.aggregationSize === undefined
      ? undefined
      : positiveInteger(input.aggregationSize, "输入聚合批次大小无效");
    const existing = key === undefined ? undefined : this.pending.get(key);
    if (
      existing?.expectedParts !== undefined
      && aggregationSize !== undefined
      && existing.expectedParts !== aggregationSize
    ) {
      return Promise.reject(new Error("输入聚合批次大小不一致"));
    }
    const currentImageCount = existing?.parts.reduce(
      (total, part) => total + (part.localImages?.length ?? 0),
      0,
    ) ?? 0;
    const currentImageBytes = existing?.parts.reduce(
      (total, part) => total + (part.localImages?.reduce(
        (partTotal, image) => partTotal + (image.bytes ?? 0),
        0,
      ) ?? 0),
      0,
    ) ?? 0;
    const inputImageBytes = localImages.reduce(
      (total, image) => total + (image.bytes ?? 0),
      0,
    );
    const limitError = currentImageCount + localImages.length > this.maximumImages
      ? new UserFacingError(
          "image.too-many",
          `一次最多处理 ${this.maximumImages} 张图片`,
          { maximumImages: String(this.maximumImages) },
        )
      : currentImageBytes + inputImageBytes > this.maximumImageBytes
        ? new UserFacingError(
            "image.too-large",
            "图片总大小超过限制",
            { scope: "batch" },
          )
        : undefined;
    if (limitError !== undefined) {
      if (key !== undefined && existing !== undefined) {
        clearTimeout(existing.timer);
        this.pending.delete(key);
        for (const part of existing.parts) {
          part.reject(limitError);
        }
      }
      return Promise.reject(
        limitError,
      );
    }

    return new Promise<SurfaceInputBatchResult>((resolve, reject) => {
      const part: PendingPart = {
        ...input,
        ...(text === undefined || text.length === 0 ? {} : { text }),
        ...(localImages.length === 0 ? {} : { localImages }),
        order: this.nextOrder,
        resolve,
        reject,
      };
      this.nextOrder += 1;
      if (key === undefined) {
        const batch: PendingBatch = {
          target: input.target,
          actorKey,
          parts: [part],
          timer: undefined as never,
        };
        const task = this.submitBatch(actorKey, batch).finally(() => {
          this.inFlight.delete(task);
        });
        this.inFlight.add(task);
        return;
      }
      if (existing !== undefined) {
        clearTimeout(existing.timer);
        existing.parts.push(part);
        if (
          existing.expectedParts !== undefined
          && existing.parts.length >= existing.expectedParts
        ) {
          void this.flush(key, existing);
        } else {
          existing.timer = this.scheduleFlush(key, existing);
        }
        return;
      }
      const batch: PendingBatch = {
        target: input.target,
        actorKey,
        ...(aggregationSize === undefined
          ? {}
          : { expectedParts: aggregationSize }),
        parts: [part],
        timer: undefined as never,
      };
      this.pending.set(key, batch);
      if (batch.expectedParts === 1) {
        void this.flush(key, batch);
      } else {
        batch.timer = this.scheduleFlush(key, batch);
      }
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const [key, batch] of [...this.pending]) {
        clearTimeout(batch.timer);
        void this.flush(key, batch);
      }
      for (const pending of this.pendingVisionPrompts.values()) {
        clearTimeout(pending.timer);
      }
      this.pendingVisionPrompts.clear();
    }
    await Promise.allSettled([...this.inFlight]);
  }

  flushPending(
    target: ConversationTarget,
    actorId: string,
  ): Promise<void> {
    const actorKey = batchKey(target, actorId);
    const pending = [...this.pending].filter(([, batch]) =>
      batch.actorKey === actorKey
    );
    return pending.length === 0
      ? Promise.resolve()
      : Promise.all(pending.map(([key, batch]) => this.flush(key, batch))).then(
          () => undefined,
        );
  }

  private scheduleFlush(key: string, batch: PendingBatch): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.flush(key, batch);
    }, this.quietWindowMs);
    timer.unref();
    return timer;
  }

  private flush(key: string, batch: PendingBatch): Promise<void> {
    if (this.pending.get(key) !== batch) {
      return Promise.resolve();
    }
    this.pending.delete(key);
    clearTimeout(batch.timer);
    const task = this.submitBatch(batch.actorKey, batch).finally(() => {
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
    return task;
  }

  private async submitBatch(key: string, batch: PendingBatch): Promise<void> {
    const parts = [...batch.parts].sort(
      (left, right) => left.sequence - right.sequence || left.order - right.order,
    );
    const texts = parts.flatMap((part) =>
      part.text === undefined ? [] : [part.text]
    );
    const localImages = parts.flatMap((part) =>
      (part.localImages ?? []).map(({ path }) => ({ path }))
    );
    const visionPrompt = localImages.length === 0
      ? undefined
      : this.consumeVisionPrompt(key);
    const providedText = [
      ...(visionPrompt === undefined ? [] : [visionPrompt]),
      ...texts,
    ].join("\n\n");
    const text = providedText || (localImages.length === 1
      ? "请查看这张图片并根据图片内容协助我。"
      : "请查看这些图片并根据图片内容协助我。");
    const value = localImages.length === 0
      ? text
      : { text, localImages };
    try {
      const submission = await this.submit(batch.target, value);
      parts.forEach((part, index) => {
        part.resolve({
          submission,
          tail: index === parts.length - 1,
        });
      });
    } catch (error) {
      for (const part of parts) {
        part.reject(error);
      }
    }
  }

  private consumeVisionPrompt(key: string): string | undefined {
    const pending = this.pendingVisionPrompts.get(key);
    if (pending === undefined) return undefined;
    clearTimeout(pending.timer);
    this.pendingVisionPrompts.delete(key);
    return pending.prompt;
  }
}

function batchKey(target: ConversationTarget, actorId: string): string {
  return [
    target.surface,
    target.accountId,
    target.conversationId,
    actorId,
  ].join("\u0000");
}

function positiveInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}

function nonNegativeInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(message);
  }
  return value;
}
