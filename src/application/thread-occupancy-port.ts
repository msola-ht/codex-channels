import type { ConversationTarget } from "../conversation-core/index.js";

export interface ThreadLockHolder {
  pid: number;
  command: string;
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
  | { status: "unidentifiable"; threadId: string };

export interface ThreadOccupancyPort {
  releaseThread(
    target: ConversationTarget,
    force?: boolean,
  ): Promise<ThreadOccupancyReleaseResult>;
}
