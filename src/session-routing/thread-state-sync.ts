import type { SessionRouter, ThreadModelSettings } from "./router.js";

export type ThreadStateEvent =
  | {
      type: "thread.settings.updated";
      threadId: string;
      settings: ThreadModelSettings;
      cwd: string;
    }
  | { type: "thread.name.updated"; threadId: string; name: string | null }
  | { type: "thread.archived"; threadId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "thread.closed"; threadId: string };

export class ThreadStateSynchronizer {
  constructor(private readonly router: SessionRouter) {}

  /** Apply freshness facts before asynchronous presentation queues. */
  observeExecutionContext(event: ThreadStateEvent): (() => boolean) | undefined {
    if (event.type === "thread.settings.updated") {
      this.router.observeThreadCwd(event.threadId, event.cwd);
      this.router.updateModelSettings(event.threadId, event.settings);
    }
    else if (event.type === "thread.closed") return this.router.markThreadUnsubscribed(event.threadId);
    else if (event.type === "thread.archived" || event.type === "thread.deleted") {
      this.router.invalidateExecutionContext(event.threadId);
    }
    return undefined;
  }

  handle(event: ThreadStateEvent): void {
    switch (event.type) {
      case "thread.settings.updated":
        // Settings facts were reduced at admission. Replaying an older queued
        // event here would overwrite a newer notification or lifecycle result.
        return;
      case "thread.name.updated":
        this.router.updateThreadName(event.threadId, event.name);
        return;
      case "thread.archived":
        this.router.forgetThread(event.threadId);
        return;
      case "thread.deleted":
        this.router.forgetDeletedThread(event.threadId);
        return;
      case "thread.closed":
        this.router.requestSubscriptionRestore(event.threadId);
        return;
    }
  }
}
