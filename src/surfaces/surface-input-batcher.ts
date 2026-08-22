import type {
  ConversationInput,
  Submission,
} from "../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import {
  GeneratedImageError,
  readGeneratedImage,
  type GeneratedImage,
} from "./generated-image.js";

const DEFAULT_QUIET_WINDOW_MS = 1_000;
const DEFAULT_MAXIMUM_IMAGES = 4;
const DEFAULT_MAXIMUM_IMAGE_BYTES = 20 * 1024 * 1024;

export interface SurfaceInputPart {
  target: ConversationTarget;
  actorId: string;
  sequence: number;
  text?: string;
  localImages?: ReadonlyArray<{
    path: string;
    mimeType: "image/jpeg" | "image/png";
    bytes?: number;
  }>;
  aggregationKey?: string;
  aggregationSize?: number;
}

export interface SurfaceInputSubmissionResult {
  kind?: never;
  submission: Submission;
  tail: boolean;
}

export interface SurfaceInputBatcherOptions {
  quietWindowMs?: number;
  maximumImages?: number;
  maximumImageBytes?: number;
  onSubmissionFailure?(input: SurfaceInputPart, error: unknown): void;
}

type SubmitConversationInput = (
  target: ConversationTarget,
  input: string | ConversationInput,
) => Promise<Submission>;

interface PendingPart extends SurfaceInputPart {
  order: number;
  resolve(result: SurfaceInputSubmissionResult): void;
  reject(error: unknown): void;
}

interface PendingBatch {
  target: ConversationTarget;
  actorKey: string;
  expectedParts?: number;
  parts: PendingPart[];
  timer: NodeJS.Timeout;
}

export class SurfaceInputBatcher {
  readonly maximumImages: number;
  readonly maximumImageBytes: number;
  private readonly quietWindowMs: number;
  private readonly pending = new Map<string, PendingBatch>();
  private readonly inFlight = new Set<Promise<void>>();
  private nextOrder = 0;
  private closed = false;

  constructor(
    private readonly submit: SubmitConversationInput,
    private readonly options: SurfaceInputBatcherOptions = {},
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

  enqueue(input: SurfaceInputPart): Promise<SurfaceInputSubmissionResult> {
    if (this.closed) {
      return Promise.reject(new Error("输入聚合器已关闭"));
    }
    const text = input.text?.trim();
    const localImages = input.localImages ?? [];
    if ((text === undefined || text.length === 0) && localImages.length === 0) {
      return Promise.reject(new Error("输入聚合内容为空"));
    }
    const actorKey = surfaceActorKey(input.target, input.actorId);
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
    const existingImages = existing?.parts.flatMap((part) => part.localImages ?? []) ?? [];
    const limitError = imageBatchLimitError(
      [...existingImages, ...localImages],
      this.maximumImages,
      this.maximumImageBytes,
    );
    if (limitError !== undefined) {
      if (key !== undefined && existing !== undefined) {
        clearTimeout(existing.timer);
        this.pending.delete(key);
        for (const part of existing.parts) {
          part.reject(limitError);
        }
      }
      return Promise.reject(limitError);
    }

    return new Promise<SurfaceInputSubmissionResult>((resolve, reject) => {
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
        const task = this.submitBatch(batch).finally(() => {
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
    }
    await Promise.allSettled([...this.inFlight]);
  }

  flushPending(
    target: ConversationTarget,
    actorId: string,
  ): Promise<void> {
    const actorKey = surfaceActorKey(target, actorId);
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
    const localImages = parts.flatMap((part) => part.localImages ?? []);
    const text = texts.join("\n") || (localImages.length === 1
      ? "请查看这张图片并根据图片内容协助我。"
      : "请查看这些图片并根据图片内容协助我。");
    try {
      const images = await Promise.all(localImages.map(toInlineImage));
      const limitError = imageBatchLimitError(
        images,
        this.maximumImages,
        this.maximumImageBytes,
      );
      if (limitError !== undefined) {
        throw limitError;
      }
      const value: string | ConversationInput = images.length === 0
        ? text
        : {
            text,
            images: images.map(({ url }) => ({ url })),
          };
      const submission = await this.submit(batch.target, value);
      parts.forEach((part, index) => {
        part.resolve({
          submission,
          tail: index === parts.length - 1,
        });
      });
    } catch (error) {
      this.options.onSubmissionFailure?.({
        target: batch.target,
        actorId: parts[0]!.actorId,
        sequence: parts[0]!.sequence,
        text,
      }, error);
      for (const part of parts) {
        part.reject(error);
      }
    }
  }
}

interface InlineImage {
  url: string;
  bytes: number;
}

async function toInlineImage(image: {
  path: string;
  mimeType: "image/jpeg" | "image/png";
}): Promise<InlineImage> {
  let stored: GeneratedImage;
  try {
    stored = await readGeneratedImage(image.path);
  } catch (error) {
    if (error instanceof GeneratedImageError && error.code === "too-large") {
      throw new UserFacingError("image.too-large", "图片超过 10 MiB 限制");
    }
    throw new UserFacingError("image.unsupported", "图片无法读取");
  }
  const expectedFormat = image.mimeType === "image/png" ? "png" : "jpeg";
  if (stored.format !== expectedFormat) {
    throw new UserFacingError("image.unsupported", "图片类型无效");
  }
  return {
    url: `data:${image.mimeType};base64,${stored.bytes.toString("base64")}`,
    bytes: stored.bytes.length,
  };
}

export function surfaceActorKey(
  target: ConversationTarget,
  actorId: string,
): string {
  return [
    target.surface,
    target.accountId,
    target.conversationId,
    actorId,
  ].join("\u0000");
}

export function imageBatchLimitError(
  images: ReadonlyArray<{ bytes?: number }>,
  maximumImages: number,
  maximumImageBytes: number,
): UserFacingError | undefined {
  if (images.length > maximumImages) {
    return new UserFacingError(
      "image.too-many",
      `一次最多处理 ${maximumImages} 张图片`,
      { maximumImages: String(maximumImages) },
    );
  }
  const bytes = images.reduce((total, image) => total + (image.bytes ?? 0), 0);
  return bytes > maximumImageBytes
    ? new UserFacingError(
        "image.too-large",
        "图片总大小超过限制",
        { scope: "batch" },
      )
    : undefined;
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
