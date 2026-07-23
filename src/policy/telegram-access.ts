import type { SurfaceAccessContext, SurfaceAccessPolicy } from "./surface-access.js";

export class TelegramAccessPolicy implements SurfaceAccessPolicy {
  private allowedUserIds: ReadonlySet<number>;

  constructor(allowedUserIds: ReadonlySet<number>) {
    this.allowedUserIds = new Set(allowedUserIds);
  }

  replace(allowedUserIds: ReadonlySet<number>): void {
    this.allowedUserIds = new Set(allowedUserIds);
  }

  isAllowed(context: SurfaceAccessContext): boolean {
    if (context.target.surface !== "telegram") {
      return false;
    }
    const userId = Number(context.actorId);
    return Number.isSafeInteger(userId)
      && String(userId) === context.actorId
      && this.allowedUserIds.has(userId);
  }
}
