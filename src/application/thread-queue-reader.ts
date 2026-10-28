import { UserFacingError } from "../conversation-core/index.js";
import { ThreadQueueError, type ThreadQueuePort } from "./thread-queue-port.js";

export const maximumNativeQueueItems = 100;

/** Native queues belong to App Server; Gateway only checks binding safety. */
export async function hasNativeQueueItems(
  queue: ThreadQueuePort | undefined,
  threadId: string,
  assertAuthorized?: () => void,
): Promise<boolean> {
  assertAuthorized?.();
  if (!queue) return false;
  try {
    const page = await queue.listQueue(threadId, { limit: 1, ...(assertAuthorized ? { beforeSubmit: assertAuthorized } : {}) });
    assertAuthorized?.();
    if (!Number.isSafeInteger(page.itemCount) || page.itemCount < 0) {
      throw new UserFacingError("queue.failed", "无法确认原生队列状态，请稍后重试");
    }
    return page.itemCount > 0 || page.nextCursor !== null;
  } catch (error) {
    assertAuthorized?.();
    if (error instanceof ThreadQueueError && error.failure === "unavailable") return false;
    throw queueReadError(error);
  }
}

export function queueReadError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error;
  if (error instanceof ThreadQueueError && error.failure === "unavailable") {
    return new UserFacingError("queue.unavailable", "当前 App Server 不提供原生队列读取能力");
  }
  return new UserFacingError("queue.failed", "原生队列读取失败，请稍后重试");
}
