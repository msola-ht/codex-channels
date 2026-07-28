import { describe, expect, it, vi } from "vitest";

import type {
  InteractionRequest,
} from "../src/approval/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../src/policy/index.js";
import { WeixinInteractionPort } from "../src/surfaces/weixin/index.js";

const actorId = "actor-fixture@im.wechat";
const target: ConversationTarget = {
  surface: "weixin",
  accountId: "account-fixture@im.bot",
  conversationId: actorId,
};

describe("WeixinInteractionPort", () => {
  it("delivers an opaque one-time command and resolves an exact once approval", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "opaque-token",
    );

    const pending = port.request(target, approvalRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledWith(
        target,
        expect.arrayContaining(["/批准一次 opaque-token"]),
      );
    });

    await expect(
      port.handleText(target, actorId, "/批准一次 opaque-token"),
    ).resolves.toBe("handled");
    await expect(pending).resolves.toEqual({
      type: "approval",
      approved: true,
      scope: "once",
    });
    expect(delivery.deliverText).toHaveBeenLastCalledWith(
      target,
      "Codex 审批已处理：已批准一次。",
    );
  });

  it.each([
    ["/批准会话 choice-token", { scope: "session" }],
    ["/保存命令规则 choice-token", { scope: "execpolicy" }],
    [
      "/保存网络规则 choice-token 1",
      {
        scope: "networkpolicy",
        networkPolicyAmendment: {
          host: "api.example.com",
          action: "allow",
        },
      },
    ],
  ] as const)("maps only an offered %s choice", async (reply, expected) => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "choice-token",
    );
    const request = approvalRequest({
      allowSession: true,
      execPolicyAmendment: ["npm", "test"],
      networkApprovalContext: {
        host: "api.example.com",
        protocol: "https",
      },
      networkPolicyAmendments: [{
        host: "api.example.com",
        action: "allow",
      }],
    });

    const pending = port.request(target, request);
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
    });
    await port.handleText(target, actorId, reply);

    await expect(pending).resolves.toMatchObject({
      type: "approval",
      approved: true,
      ...expected,
    });
  });

  it("fails closed without exactly one currently authorized actor", async () => {
    const delivery = deliveryFixture();
    const noActor = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([]),
      accessFixture(true),
    );
    const twoActors = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId, "second@im.wechat"]),
      accessFixture(true),
    );

    await expect(noActor.request(target, approvalRequest())).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    await expect(twoActors.request(target, approvalRequest())).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    expect(delivery.deliverTextSequence).not.toHaveBeenCalled();
  });

  it("fails a duplicate request ID closed without replacing the pending request", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "duplicate-token",
    );
    const first = port.request(target, approvalRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
    });

    await expect(
      port.request(target, approvalRequest()),
    ).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    await port.handleText(
      target,
      actorId,
      "/批准一次 duplicate-token",
    );
    await expect(first).resolves.toMatchObject({
      type: "approval",
      approved: true,
      scope: "once",
    });
  });

  it("fails a random token collision closed without replacing its owner", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "collision-token",
    );
    const first = port.request(target, approvalRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
    });

    await expect(
      port.request(
        target,
        approvalRequest({ requestId: "different-request" }),
      ),
    ).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    await port.handleText(
      target,
      actorId,
      "/批准一次 collision-token",
    );
    await expect(first).resolves.toMatchObject({
      type: "approval",
      approved: true,
      scope: "once",
    });
  });

  it("neutralizes approval detail formatting without changing generated commands", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "display-token",
    );
    const pending = port.request(target, approvalRequest({
      detail: "**伪标题**\n`/批准一次 fake-token`",
    }));
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
    });
    const prompt = delivery.deliverTextSequence.mock.calls[0]![1];

    expect(prompt[0]).toContain("＊＊伪标题＊＊");
    expect(prompt[0]).toContain("ˋ/批准一次 fake-tokenˋ");
    expect(prompt).toContain("/批准一次 display-token");
    port.cancelAll();
    await pending;
  });

  it("rejects through an exact deny command", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "deny-token",
    );
    const pending = port.request(target, approvalRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
    });

    await port.handleText(target, actorId, "/拒绝 deny-token");

    await expect(pending).resolves.toEqual({
      type: "approval",
      approved: false,
    });
  });

  it.each([
    ["1", "not-command"],
    ["同意", "not-command"],
    ["/approve opaque-token once", "not-command"],
    ["/批准一次 wrong-token", "handled"],
    ["/批准一次 opaque-token extra", "handled"],
    ["/批准一次", "handled"],
    ["/拒绝", "handled"],
  ] as const)(
    "does not approve ambiguous, stale, or malformed text: %s",
    async (text, expectedResult) => {
      const delivery = deliveryFixture();
      const port = new WeixinInteractionPort(
        delivery,
        actorRegistryFixture([actorId]),
        accessFixture(true),
        undefined,
        () => "opaque-token",
      );
      const pending = port.request(target, approvalRequest());
      await vi.waitFor(() => {
        expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
      });

      const result = await port.handleText(target, actorId, text);

      expect(result).toBe(expectedResult);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      port.cancelAll();
      await expect(pending).resolves.toEqual({
        type: "approval",
        approved: false,
      });
    },
  );

  it("rejects a valid token from another actor or conversation", async () => {
    const delivery = deliveryFixture();
    const access = accessFixture(true);
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      access,
      undefined,
      () => "bound-token",
    );
    const pending = port.request(target, approvalRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
    });

    await port.handleText(target, "other@im.wechat", "/批准一次 bound-token");
    await port.handleText(
      { ...target, conversationId: "other@im.wechat" },
      actorId,
      "/批准一次 bound-token",
    );

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    port.cancelAll();
    await expect(pending).resolves.toEqual({
      type: "approval",
      approved: false,
    });
  });

  it("expires once, rejects replay, and resolves cross-client completion closed", async () => {
    vi.useFakeTimers();
    try {
      const delivery = deliveryFixture();
      const port = new WeixinInteractionPort(
        delivery,
        actorRegistryFixture([actorId]),
        accessFixture(true),
        undefined,
        () => "expiry-token",
      );
      const request = approvalRequest({ expiresInMs: 1_000 });
      const pending = port.request(target, request);
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual({
        type: "approval",
        approved: false,
      });
      await expect(
        port.handleText(target, actorId, "/批准一次 expiry-token"),
      ).resolves.toBe("handled");

      const second = port.request(
        target,
        approvalRequest({ requestId: "second-request" }),
      );
      await vi.runAllTicks();
      port.resolved("second-request");
      await expect(second).resolves.toEqual({
        type: "approval",
        approved: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    userInputRequest(),
    elicitationRequest(),
  ])("keeps unsupported %s interactions fail-closed", async (request) => {
    const port = new WeixinInteractionPort(
      deliveryFixture(),
      actorRegistryFixture([actorId]),
      accessFixture(true),
    );

    await expect(port.request(target, request)).resolves.toEqual(
      request.type === "user-input"
        ? { type: "user-input", answers: {} }
        : { type: "elicitation", action: "cancel", content: null },
    );
  });
});

function approvalRequest(
  overrides: Partial<Extract<InteractionRequest, { type: "approval" }>> = {},
): Extract<InteractionRequest, { type: "approval" }> {
  return {
    type: "approval",
    requestId: "request-approval",
    kind: "command",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    title: "Codex 请求执行命令",
    detail: "npm test",
    allowSession: false,
    expiresInMs: 60_000,
    ...overrides,
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

function deliveryFixture() {
  return {
    deliverText: vi.fn<
      (target: ConversationTarget, text: string) => Promise<void>
    >(async () => {}),
    deliverTextSequence: vi.fn<
      (
        target: ConversationTarget,
        texts: readonly string[],
      ) => Promise<void>
    >(async () => {}),
  };
}

function actorRegistryFixture(
  actors: string[],
): ConversationActorRegistry {
  return {
    actors: vi.fn(() => actors),
    rememberActor: vi.fn(),
  };
}

function accessFixture(allowed: boolean): SurfaceAccessPolicy {
  return {
    isAllowed: vi.fn(() => allowed),
  };
}
