import type { SessionRouter, ThreadModelSettings } from "./router.js";

export type ThreadStateEvent =
  | {
      type: "thread.settings.updated";
      threadId: string;
      settings: ThreadModelSettings;
    }
  | { type: "thread.archived"; threadId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "thread.closed"; threadId: string };

export class ThreadStateSynchronizer {
  constructor(private readonly router: SessionRouter) {}

  handle(event: ThreadStateEvent): void {
    switch (event.type) {
      case "thread.settings.updated":
        this.router.updateModelSettings(event.threadId, event.settings);
        return;
      case "thread.archived":
        this.router.forgetThread(event.threadId);
        return;
      case "thread.deleted":
        this.router.forgetDeletedThread(event.threadId);
        return;
      case "thread.closed":
        return;
    }
  }
}
