import type {
  SurfaceAccessContext,
  SurfaceAccessPolicy,
} from "./surface-access.js";

export class WeixinAccessPolicy implements SurfaceAccessPolicy {
  private allowedUserIds: ReadonlySet<string>;

  constructor(
    allowedUserIds: ReadonlySet<string>,
    private readonly accountId: string,
  ) {
    this.allowedUserIds = new Set(allowedUserIds);
  }

  replace(allowedUserIds: ReadonlySet<string>): void {
    this.allowedUserIds = new Set(allowedUserIds);
  }

  isAllowed(context: SurfaceAccessContext): boolean {
    return context.target.surface === "weixin"
      && context.target.accountId === this.accountId
      && this.allowedUserIds.has(context.actorId);
  }
}
