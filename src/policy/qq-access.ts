import type { SurfaceAccessContext, SurfaceAccessPolicy } from "./surface-access.js";

export class QqAccessPolicy implements SurfaceAccessPolicy {
  private users: ReadonlySet<string>;
  constructor(users: ReadonlySet<string>, private readonly appId: string) {
    this.users = new Set(users);
  }
  replace(users: ReadonlySet<string>): void { this.users = new Set(users); }
  isAllowed({ target, actorId }: SurfaceAccessContext): boolean {
    return target.surface === "qq" && target.accountId === this.appId
      && target.conversationId === `c2c:${actorId}` && this.users.has(actorId);
  }
}
