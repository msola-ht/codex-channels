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

export interface SurfaceInputPart {
  target: ConversationTarget;
  actorId: string;
  sequence: number;
  text?: string;
  localImages?: ReadonlyArray<{ path: string; bytes?: number }>;
}

export interface SurfaceInputBatchResult {
  submission: Submission;
  tail: boolean;
}

export interface SurfaceInputCoalescerOptions {
  quietWindowMs?: number;
  maximumImages?: number;
  maximumImageBytes?: number;
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
  parts: PendingPart[];
  timer: NodeJS.Timeout;
}

export class SurfaceInputCoalescer {
  private readonly quietWindowMs: number;
  private readonly maximumImages: number;
  private readonly maximumImageBytes: number;
  private readonly pending = new Map<string, PendingBatch>();
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
    const key = batchKey(input.target, input.actorId);
    const existing = this.pending.get(key);
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
      if (existing !== undefined) {
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
      if (existing !== undefined) {
        clearTimeout(existing.timer);
        existing.parts.push(part);
        existing.timer = this.scheduleFlush(key, existing);
        return;
      }
      const batch: PendingBatch = {
        target: input.target,
        parts: [part],
        timer: undefined as never,
      };
      batch.timer = this.scheduleFlush(key, batch);
      this.pending.set(key, batch);
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const [key, batch] of [...this.pending]) {
        clearTimeout(batch.timer);
        void this.flush(key, batch);
      }
    }
    await Promise.allSettled([...this.inFlight]);
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
    const task = this.submitBatch(batch).finally(() => {
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
    return task;
  }

  private async submitBatch(batch: PendingBatch): Promise<void> {
    const parts = [...batch.parts].sort(
      (left, right) => left.sequence - right.sequence || left.order - right.order,
    );
    const texts = parts.flatMap((part) =>
      part.text === undefined ? [] : [part.text]
    );
    const localImages = parts.flatMap((part) =>
      (part.localImages ?? []).map(({ path }) => ({ path }))
    );
    const text = texts.length > 0
      ? texts.join("\n")
      : localImages.length === 1
        ? "请查看这张图片并根据图片内容协助我。"
        : "请查看这些图片并根据图片内容协助我。";
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
