import { describe, expect, it } from "vitest";

import {
  resolveApprovalChoice,
  type ApprovalChoice,
  type InteractionRequest,
} from "../src/approval/index.js";
import type { InteractionDecision } from "../src/approval/types.js";

function approvalInteractionRequest(
  overrides: Partial<Extract<InteractionRequest, { type: "approval" }>> = {},
): Extract<InteractionRequest, { type: "approval" }> {
  return {
    type: "approval",
    requestId: "request-choice",
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    title: "审批",
    detail: "npm test",
    allowSession: true,
    execPolicyAmendment: ["git", "commit"],
    networkApprovalContext: { host: "api.example.com", protocol: "https" },
    networkPolicyAmendments: [
      { host: "api.example.com", action: "allow" },
      { host: "api.example.com", action: "deny" },
    ],
    expiresInMs: 30_000,
    ...overrides,
  };
}

describe("resolveApprovalChoice", () => {
  it.each<{
    choice: ApprovalChoice;
    expected: InteractionDecision | undefined;
  }>([
    { choice: { type: "once" }, expected: { type: "approval", approved: true, scope: "once" } },
    { choice: { type: "session" }, expected: { type: "approval", approved: true, scope: "session" } },
    { choice: { type: "execpolicy" }, expected: { type: "approval", approved: true, scope: "execpolicy" } },
    {
      choice: { type: "networkpolicy", amendmentIndex: 1 },
      expected: { type: "approval", approved: true, scope: "networkpolicy", networkPolicyAmendment: { host: "api.example.com", action: "deny" } },
    },
    { choice: { type: "reject" }, expected: { type: "approval", approved: false } },
    { choice: { type: "networkpolicy", amendmentIndex: 2 }, expected: undefined },
  ])("resolves the platform-neutral $choice.type choice", ({ choice, expected }) => {
    const result = resolveApprovalChoice(approvalInteractionRequest(), choice);
    expect(result?.decision).toEqual(expected);
  });

  it("rejects choices that the current request did not offer", () => {
    const request = approvalInteractionRequest({ allowSession: false });
    delete request.execPolicyAmendment;
    delete request.networkPolicyAmendments;

    expect(resolveApprovalChoice(request, { type: "session" })).toBeUndefined();
    expect(resolveApprovalChoice(request, { type: "execpolicy" })).toBeUndefined();
    expect(resolveApprovalChoice(request, { type: "networkpolicy", amendmentIndex: 0 })).toBeUndefined();
  });
});
