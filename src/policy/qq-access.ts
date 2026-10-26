import type { SurfaceAccessContext, SurfaceAccessPolicy } from "./surface-access.js";

export class QqAccessPolicy implements SurfaceAccessPolicy {
  private users: ReadonlySet<string>;
  constructor(users: ReadonlySet<string>, private readonly appId: string) {
    this.users = new Set(users);
  }
  replace(users: ReadonlySet<string>): void {
    this.users = new Set(users);
  }
  isAllowed({ target, actorId }: SurfaceAccessContext): boolean {
    if (target.surface !== "qq" || target.accountId !== this.appId) return false;
    // QQ 业务仅支持单聊；未知目标不授予输入、恢复或出站能力。
    return target.conversationId === `c2c:${actorId}` && this.users.has(actorId);
  }
}
