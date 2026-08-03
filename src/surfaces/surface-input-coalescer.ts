import type { Submission } from "../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import {
  SurfaceInputBatcher,
  surfaceActorKey,
  type SurfaceInputBatcherOptions,
  type SurfaceInputPart,
  type SurfaceInputSubmissionResult,
} from "./surface-input-batcher.js";
import { VisionInputSession } from "./vision-input-session.js";

export type { SurfaceInputPart } from "./surface-input-batcher.js";

export interface SurfaceInputCollectedResult {
  kind: "collected";
  imageCount: number;
  maximumImages: number;
  automatic: boolean;
}

export type SurfaceInputBatchResult =
  | SurfaceInputSubmissionResult
  | SurfaceInputCollectedResult;

export interface SurfaceInputCoalescerOptions extends SurfaceInputBatcherOptions {
  visionPromptTtlMs?: number;
  maximumPendingVisionPrompts?: number;
  onVisionCollectionReady?(
    target: ConversationTarget,
    imageCount: number,
    maximumImages: number,
  ): void;
}

export interface CompletedVisionCollectionResult {
  submission: Submission;
  imageCount: number;
}

interface VisionRetryState {
  input: SurfaceInputPart;
  timer: NodeJS.Timeout;
}

export class SurfaceInputCoalescer {
  private readonly batcher: SurfaceInputBatcher;
  private readonly vision: VisionInputSession;
  private readonly visionRetryTtlMs: number;
  private readonly maximumVisionRetries: number;
  private readonly visionRetries = new Map<string, VisionRetryState>();
  private closed = false;

  constructor(
    submit: ConstructorParameters<typeof SurfaceInputBatcher>[0],
    private readonly options: SurfaceInputCoalescerOptions = {},
  ) {
    this.visionRetryTtlMs = options.visionPromptTtlMs ?? 5 * 60 * 1_000;
    this.maximumVisionRetries = options.maximumPendingVisionPrompts ?? 1_000;
    this.batcher = new SurfaceInputBatcher(submit, {
      ...options,
      onSubmissionFailure: (input, error) => {
        if (
          error instanceof UserFacingError
          && error.code === "vision.failed"
          && (input.localImages?.length ?? 0) > 0
        ) {
          this.rememberVisionRetry(input);
        }
      },
    });
    this.vision = new VisionInputSession({
      maximumImages: this.batcher.maximumImages,
      maximumImageBytes: this.batcher.maximumImageBytes,
      ...(options.visionPromptTtlMs === undefined
        ? {}
        : { ttlMs: options.visionPromptTtlMs }),
      ...(options.maximumPendingVisionPrompts === undefined
        ? {}
        : { maximumSessions: options.maximumPendingVisionPrompts }),
    });
  }

  setVisionPrompt(
    target: ConversationTarget,
    actorId: string,
    value: string,
  ): { replaced: boolean } {
    const result = this.vision.setPrompt(target, actorId, value);
    this.clearVisionRetry(target, actorId);
    return result;
  }

  beginVisionCollection(
    target: ConversationTarget,
    actorId: string,
    value: string,
    expectedImages?: number,
  ): { replacedPrompt: boolean } {
    const result = this.vision.beginCollection(
      target,
      actorId,
      value,
      expectedImages,
    );
    this.clearVisionRetry(target, actorId);
    return result;
  }

  cancelVisionPrompt(target: ConversationTarget, actorId: string): boolean {
    const pendingCancelled = this.vision.cancel(target, actorId);
    const retryCancelled = this.clearVisionRetry(target, actorId);
    return pendingCancelled || retryCancelled;
  }

  async retryVision(
    target: ConversationTarget,
    actorId: string,
  ): Promise<CompletedVisionCollectionResult> {
    const key = surfaceActorKey(target, actorId);
    const retry = this.visionRetries.get(key);
    if (retry === undefined) {
      throw new UserFacingError(
        "vision.retry.missing",
        "当前没有可重试的图片识别任务",
      );
    }
    clearTimeout(retry.timer);
    this.visionRetries.delete(key);
    const result = await this.batcher.enqueue(retry.input);
    return {
      submission: result.submission,
      imageCount: retry.input.localImages?.length ?? 0,
    };
  }

  async completeVisionCollection(
    target: ConversationTarget,
    actorId: string,
  ): Promise<CompletedVisionCollectionResult> {
    const completed = this.vision.complete(target, actorId);
    const result = await this.batcher.enqueue(completed.input);
    return {
      submission: result.submission,
      imageCount: completed.imageCount,
    };
  }

  enqueue(input: SurfaceInputPart): Promise<SurfaceInputBatchResult> {
    let decision;
    try {
      decision = this.vision.accept(input);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("图片输入处理失败"),
      );
    }
    if (decision.kind === "collected") {
      return Promise.resolve(decision);
    }
    const submissionInput = decision.kind === "submit" ? decision.input : input;
    if ((submissionInput.localImages?.length ?? 0) > 0) {
      this.clearVisionRetry(input.target, input.actorId);
    }
    if (decision.kind === "submit" && decision.automaticCollection) {
      this.options.onVisionCollectionReady?.(
        input.target,
        decision.automaticCollection.imageCount,
        decision.automaticCollection.maximumImages,
      );
    }
    return this.batcher.enqueue(submissionInput);
  }

  flushPending(
    target: ConversationTarget,
    actorId: string,
  ): Promise<void> {
    return this.batcher.flushPending(target, actorId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.vision.close();
    for (const retry of this.visionRetries.values()) clearTimeout(retry.timer);
    this.visionRetries.clear();
    await this.batcher.close();
  }

  private rememberVisionRetry(input: SurfaceInputPart): void {
    if (this.closed) return;
    const key = surfaceActorKey(input.target, input.actorId);
    const previous = this.visionRetries.get(key);
    if (previous !== undefined) clearTimeout(previous.timer);
    if (previous === undefined && this.visionRetries.size >= this.maximumVisionRetries) {
      return;
    }
    const retry: VisionRetryState = {
      input: {
        ...input,
        ...(input.localImages === undefined
          ? {}
          : { localImages: [...input.localImages] }),
      },
      timer: undefined as never,
    };
    retry.timer = setTimeout(() => {
      if (this.visionRetries.get(key) === retry) this.visionRetries.delete(key);
    }, this.visionRetryTtlMs);
    retry.timer.unref();
    this.visionRetries.set(key, retry);
  }

  private clearVisionRetry(
    target: ConversationTarget,
    actorId: string,
  ): boolean {
    const key = surfaceActorKey(target, actorId);
    const retry = this.visionRetries.get(key);
    if (retry === undefined) return false;
    clearTimeout(retry.timer);
    this.visionRetries.delete(key);
    return true;
  }
}
