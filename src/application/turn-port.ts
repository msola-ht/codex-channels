import type {
  ThreadApprovalsReviewer,
} from "../conversation-core/index.js";

export type TurnInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "plugin"; name: string; path: string };

export interface TurnCollaborationMode {
  mode: "default" | "plan";
  settings: {
    model: string;
    effort: string | null;
    developerInstructions: null;
  };
}

export interface TurnOverrides {
  /** Explicit user input origin; scheduled execution leaves this unset. */
  turnTrigger?: "user";
  /** Local guard; never serialized, and does not cancel an already submitted write. */
  beforeSubmit?: () => void;
  /** Local notification immediately before the write RPC; no retry or delivery guarantee. */
  requestAttempted?: () => undefined;
  model?: string;
  modelProvider?: string;
  effort?: string;
  serviceTier?: string | null;
  collaborationMode?: TurnCollaborationMode;
}

export interface TurnStarted {
  turnId: string;
}

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

export interface ReviewStarted extends TurnStarted {
  threadId: string;
}

/**
 * Changes only the loaded Thread's reviewer, without starting a Turn.
 * The application-facing port resolves after authoritative confirmation has
 * reached the shared routing reducer; it never optimistically writes state.
 */
export interface ThreadApprovalsReviewerPort {
  updateThreadApprovalsReviewer(threadId: string, reviewer: Extract<ThreadApprovalsReviewer, "user" | "auto_review">, beforeSubmit?: () => void): Promise<void>;
}

export interface TurnExecutionPort {
  /** Cancels client-side preparation before an App Server Turn exists. */
  cancelPendingInput?(threadId: string): boolean;
  startTurn(
    threadId: string,
    input: TurnInput[],
    clientUserMessageId: string,
    cwd: string,
    overrides?: TurnOverrides,
  ): Promise<TurnStarted>;
  steerTurn(
    threadId: string,
    turnId: string,
    input: TurnInput[],
    clientUserMessageId: string,
    beforeSubmit?: () => void,
    requestAttempted?: () => undefined,
  ): Promise<TurnStarted>;
  interruptTurn(threadId: string, turnId: string, beforeSubmit?: () => void): Promise<void>;
  setThreadName(threadId: string, name: string, beforeSubmit?: () => void): Promise<void>;
  setThreadPinned(threadId: string, pinned: boolean, beforeSubmit?: () => void): Promise<boolean>;
  compactThread(threadId: string, beforeSubmit?: () => void): Promise<void>;
  startReview(threadId: string, target: ReviewTarget, beforeSubmit?: () => void, requestAttempted?: () => undefined): Promise<ReviewStarted>;
}
