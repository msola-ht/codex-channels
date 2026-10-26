import type { ConversationTarget } from "../conversation-core/index.js";

export interface ThreadLockHolder {
  pid: number;
  command: string;
  executable?: string;
  startedAt?: string;
}

/** Identity captured by a fully delivered force-release preview. */
export interface ThreadOccupancyIdentity {
  threadId: string;
  pid: number;
  startedAt: string;
}

export type ThreadOccupancyReleaseResult =
  | { status: "unbound" }
  | { status: "free"; threadId: string }
  | { status: "released"; threadId: string; holder: ThreadLockHolder }
  | {
      status: "held";
      threadId: string;
      holder: ThreadLockHolder;
      releasable: boolean;
      stuck: boolean;
    }
  | {
      status: "unidentifiable";
      threadId: string;
      reason: "unsupported-platform" | "inspection-unavailable";
    };

export interface ThreadOccupancyPort {
  releaseThread(
    target: ConversationTarget,
    force?: boolean,
    assertAuthorized?: () => void,
    expectedIdentity?: ThreadOccupancyIdentity,
  ): Promise<ThreadOccupancyReleaseResult>;
}
