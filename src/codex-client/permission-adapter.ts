import type { PermissionProfileOption } from "../application/index.js";
import type { PermissionProfileListResponse } from "../codex-protocol/index.js";

export interface PermissionProfilePage {
  profiles: PermissionProfileOption[];
  nextCursor: string | null;
}

export function toPermissionProfilePage(
  response: PermissionProfileListResponse,
): PermissionProfilePage {
  if (!Array.isArray(response.data)) {
    throw new Error("Codex 响应缺少有效 permission profile data");
  }
  if (response.nextCursor !== null && typeof response.nextCursor !== "string") {
    throw new Error("Codex 响应缺少有效 permission profile nextCursor");
  }
  return {
    profiles: response.data.map((profile) => {
      if (typeof profile.id !== "string" || profile.id.length === 0) {
        throw new Error("Codex 响应缺少有效 permission profile id");
      }
      if (
        profile.description !== null
        && typeof profile.description !== "string"
      ) {
        throw new Error("Codex 响应缺少有效 permission profile description");
      }
      if (typeof profile.allowed !== "boolean") {
        throw new Error("Codex 响应缺少有效 permission profile allowed");
      }
      return {
        id: profile.id,
        description: profile.description,
        allowed: profile.allowed,
      };
    }),
    nextCursor: response.nextCursor,
  };
}
