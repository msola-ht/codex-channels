import type { Submission } from "../application/index.js";
import type { ConversationTarget } from "../conversation-core/index.js";
import {
  SurfaceInputBatcher,
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

export class SurfaceInputCoalescer {
  private readonly batcher: SurfaceInputBatcher;
  private readonly vision: VisionInputSession;

  constructor(
    submit: ConstructorParameters<typeof SurfaceInputBatcher>[0],
    private readonly options: SurfaceInputCoalescerOptions = {},
  ) {
    this.batcher = new SurfaceInputBatcher(submit, options);
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
    return this.vision.setPrompt(target, actorId, value);
  }

  beginVisionCollection(
    target: ConversationTarget,
    actorId: string,
    value: string,
    expectedImages?: number,
  ): { replacedPrompt: boolean } {
    return this.vision.beginCollection(target, actorId, value, expectedImages);
  }

  cancelVisionPrompt(target: ConversationTarget, actorId: string): boolean {
    return this.vision.cancel(target, actorId);
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
    if (decision.kind === "submit" && decision.automaticCollection) {
      this.options.onVisionCollectionReady?.(
        input.target,
        decision.automaticCollection.imageCount,
        decision.automaticCollection.maximumImages,
      );
    }
    return this.batcher.enqueue(
      decision.kind === "submit" ? decision.input : input,
    );
  }

  flushPending(
    target: ConversationTarget,
    actorId: string,
  ): Promise<void> {
    return this.batcher.flushPending(target, actorId);
  }

  async close(): Promise<void> {
    this.vision.close();
    await this.batcher.close();
  }
}
