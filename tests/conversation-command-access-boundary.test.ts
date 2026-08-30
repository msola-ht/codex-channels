import { describe, expect, it } from "vitest";

import type { ConversationTarget } from "../src/conversation-core/index.js";
import { TelegramAccessPolicy } from "../src/policy/index.js";

const target: ConversationTarget = {
  surface: "telegram",
  accountId: "default",
  conversationId: "100",
};

describe("shared Surface access boundary", () => {
  it("uses target and canonical Actor identity and fails closed across Surfaces", () => {
    const access = new TelegramAccessPolicy(new Set([123]), "default");

    expect(access.isAllowed({ target, actorId: "123" })).toBe(true);
    expect(access.isAllowed({ target, actorId: "0123" })).toBe(false);
    expect(access.isAllowed({
      target: { surface: "feishu", accountId: "tenant-a", conversationId: "100" },
      actorId: "123",
    })).toBe(false);
    expect(access.isAllowed({
      target: { surface: "telegram", accountId: "other", conversationId: "100" },
      actorId: "123",
    })).toBe(false);
  });
});
