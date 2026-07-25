import type {
  SurfaceAccessContext,
  SurfaceAccessPolicy,
} from "./surface-access.js";

export class FeishuAccessPolicy implements SurfaceAccessPolicy {
  private allowedOpenIds: ReadonlySet<string>;

  constructor(
    allowedOpenIds: ReadonlySet<string>,
    private readonly accountId: string,
  ) {
    this.allowedOpenIds = new Set(allowedOpenIds);
  }

  replace(allowedOpenIds: ReadonlySet<string>): void {
    this.allowedOpenIds = new Set(allowedOpenIds);
  }

  isAllowed(context: SurfaceAccessContext): boolean {
    return context.target.surface === "feishu"
      && context.target.accountId === this.accountId
      && this.allowedOpenIds.has(context.actorId);
  }
}
