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
  observeExecutionContext(event: ThreadStateEvent): void {
    if (event.type === "thread.settings.updated") this.router.observeThreadCwd(event.threadId, event.cwd);
    else if (event.type === "thread.closed" || event.type === "thread.archived" || event.type === "thread.deleted") {
      this.router.invalidateExecutionContext(event.threadId);
    }
  }

  handle(event: ThreadStateEvent): void {
    switch (event.type) {
      case "thread.settings.updated":
        this.router.updateModelSettings(event.threadId, event.settings);
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
        this.router.markThreadClosed(event.threadId);
        return;
    }
  }
}
