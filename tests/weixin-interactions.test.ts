import { describe, expect, it } from "vitest";

import type {
  InteractionRequest,
} from "../src/approval/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import { WeixinInteractionPort } from "../src/surfaces/weixin/index.js";

const target: ConversationTarget = {
  surface: "weixin",
  accountId: "account-fixture@im.bot",
  conversationId: "actor-fixture@im.wechat",
};

describe("WeixinInteractionPort", () => {
  it.each([
    [
      approvalRequest(),
      { type: "approval", approved: false },
    ],
    [
      userInputRequest(),
      { type: "user-input", answers: {} },
    ],
    [
      elicitationRequest(),
      { type: "elicitation", action: "cancel", content: null },
    ],
  ] as const)("fails %s closed immediately", async (request, expected) => {
    const port = new WeixinInteractionPort();

    await expect(port.request(target, request)).resolves.toEqual(expected);
    expect(() => port.resolved(request.requestId)).not.toThrow();
    expect(() => port.cancelAll("closed")).not.toThrow();
  });
});

function approvalRequest(): InteractionRequest {
  return {
    type: "approval",
    requestId: "request-approval",
    kind: "command",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    title: "title",
    detail: "detail",
    allowSession: true,
    expiresInMs: 60_000,
  };
}

function userInputRequest(): InteractionRequest {
  return {
    type: "user-input",
    requestId: "request-input",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    title: "title",
    questions: [],
    expiresInMs: 60_000,
  };
}

function elicitationRequest(): InteractionRequest {
  return {
    type: "elicitation",
    requestId: "request-elicitation",
    threadId: "thread",
    turnId: null,
    title: "title",
    message: "message",
    mode: "url",
    url: "https://example.com",
    expiresInMs: 60_000,
  };
}
