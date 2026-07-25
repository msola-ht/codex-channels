import { describe, expect, it } from "vitest";

import type {
  InteractionRequest,
} from "../src/approval/index.js";
import {
  FeishuInteractionPort,
} from "../src/surfaces/feishu/index.js";

const target = {
  surface: "feishu",
  accountId: "cli_0123456789abcdef",
  conversationId: "oc_chat",
} as const;

describe("Feishu interaction port", () => {
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
  ] as const)("fails closed for %s", async (request, expected) => {
    const interactions = new FeishuInteractionPort();

    await expect(interactions.request(target, request)).resolves.toEqual(
      expected,
    );
    expect(() => interactions.resolved(request.requestId)).not.toThrow();
    expect(() => interactions.cancelAll()).not.toThrow();
  });
});

function approvalRequest(): InteractionRequest {
  return {
    type: "approval",
    requestId: "approval-1",
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    title: "运行命令",
    detail: "npm test",
    allowSession: true,
    expiresInMs: 300_000,
  };
}

function userInputRequest(): InteractionRequest {
  return {
    type: "user-input",
    requestId: "input-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    title: "需要输入",
    questions: [],
    expiresInMs: 300_000,
  };
}

function elicitationRequest(): InteractionRequest {
  return {
    type: "elicitation",
    requestId: "elicitation-1",
    threadId: "thread-1",
    turnId: null,
    title: "MCP 请求",
    message: "需要确认",
    mode: "form",
    expiresInMs: 300_000,
  };
}
