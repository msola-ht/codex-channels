import type { SurfaceAccessContext, SurfaceAccessPolicy } from "./surface-access.js";

export interface QqGroupAccess {
  readonly groupOpenId: string;
  readonly allowedMemberOpenIds: ReadonlySet<string>;
  readonly allowPublicOutput: true;
}

const MAX_GROUP_CONVERSATION_ID_BYTES = 2746;

function validGroupIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 512
    && !/[\s\p{Cc}\uD800-\uDFFF]/u.test(value);
}

/** Each authorized member has a distinct conversation; its output is public to the group. */
export function createQqGroupConversationId(groupOpenId: string, memberOpenId: string): string {
  if (!validGroupIdentity(groupOpenId) || !validGroupIdentity(memberOpenId)) {
    throw new Error("QQ 群及成员 OpenID 无效");
  }
  return `group:${Buffer.from(JSON.stringify([groupOpenId, memberOpenId]), "utf8").toString("base64url")}`;
}

export function parseQqGroupConversationId(conversationId: string): {
  groupOpenId: string; memberOpenId: string;
} | undefined {
  if (conversationId.length > MAX_GROUP_CONVERSATION_ID_BYTES || !/^group:[A-Za-z0-9_-]+$/u.test(conversationId)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(conversationId.slice(6), "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 || !validGroupIdentity(value[0]) || !validGroupIdentity(value[1])) return undefined;
    if (createQqGroupConversationId(value[0], value[1]) !== conversationId) return undefined;
    return { groupOpenId: value[0], memberOpenId: value[1] };
  } catch { return undefined; }
}

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
    // 群权限体系尚未确定。旧群配置只保留，不授予输入、恢复或出站能力。
    return target.conversationId === `c2c:${actorId}` && this.users.has(actorId);
  }
}
