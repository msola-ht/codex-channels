import {
  SurfaceInputBatcher,
  type SurfaceInputBatcherOptions,
  type SurfaceInputPart,
  type SurfaceInputSubmissionResult,
} from "./surface-input-batcher.js";
import type { ConversationTarget } from "../conversation-core/index.js";

export type { SurfaceInputPart } from "./surface-input-batcher.js";

export type SurfaceInputBatchResult = SurfaceInputSubmissionResult;
export type SurfaceInputCoalescerOptions = SurfaceInputBatcherOptions;

export class SurfaceInputCoalescer {
  private readonly batcher: SurfaceInputBatcher;

  constructor(
    submit: ConstructorParameters<typeof SurfaceInputBatcher>[0],
    options: SurfaceInputCoalescerOptions = {},
  ) {
    this.batcher = new SurfaceInputBatcher(submit, options);
  }

  enqueue(input: SurfaceInputPart): Promise<SurfaceInputBatchResult> {
    return this.batcher.enqueue(input);
  }

  flushPending(
    target: ConversationTarget,
    actorId: string,
  ): Promise<void> {
    return this.batcher.flushPending(target, actorId);
  }

  async close(): Promise<void> {
    await this.batcher.close();
  }
}
