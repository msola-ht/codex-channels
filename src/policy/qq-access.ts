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
  private groups: ReadonlyMap<string, ReadonlySet<string>>;
  constructor(users: ReadonlySet<string>, private readonly appId: string, groups: readonly QqGroupAccess[] = []) {
    this.users = new Set(users);
    this.groups = groupMembers(groups);
  }
  replace(users: ReadonlySet<string>, groups: readonly QqGroupAccess[] = []): void {
    const members = groupMembers(groups);
    this.users = new Set(users);
    this.groups = members;
  }
  isAllowed({ target, actorId }: SurfaceAccessContext): boolean {
    if (target.surface !== "qq" || target.accountId !== this.appId) return false;
    if (target.conversationId === `c2c:${actorId}`) return this.users.has(actorId);
    const group = parseQqGroupConversationId(target.conversationId);
    return group?.memberOpenId === actorId && this.groups.get(group.groupOpenId)?.has(actorId) === true;
  }
}

function groupMembers(groups: readonly QqGroupAccess[]): ReadonlyMap<string, ReadonlySet<string>> {
  const members = new Map<string, ReadonlySet<string>>();
  for (const group of groups) {
    if (group.allowPublicOutput !== true || !validGroupIdentity(group.groupOpenId) || members.has(group.groupOpenId)
      || group.allowedMemberOpenIds.size === 0 || [...group.allowedMemberOpenIds].some(id => !validGroupIdentity(id))) {
      throw new Error("QQ 群授权无效，须明确同意群内公开输出并提供独立成员名单");
    }
    members.set(group.groupOpenId, new Set(group.allowedMemberOpenIds));
  }
  return members;
}
