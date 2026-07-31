import type {
  GoalStatus,
  ThreadGoal,
} from "../conversation-core/index.js";

export type TurnInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string };

export interface TurnCollaborationMode {
  mode: "default" | "plan";
  settings: {
    model: string;
    effort: string | null;
    developerInstructions: null;
  };
}

export interface TurnOverrides {
  model?: string;
  modelProvider?: string;
  modelCatalogPath?: string;
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

export type { GoalStatus, ThreadGoal };

export interface TurnExecutionPort {
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
  ): Promise<TurnStarted>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  setThreadName(threadId: string, name: string): Promise<void>;
  setThreadPinned(threadId: string, pinned: boolean): Promise<void>;
  compactThread(threadId: string): Promise<void>;
  startReview(threadId: string, target: ReviewTarget): Promise<ReviewStarted>;
  getGoal(threadId: string): Promise<ThreadGoal | null>;
  setGoal(threadId: string, objective: string): Promise<ThreadGoal>;
  clearGoal(threadId: string): Promise<void>;
}
