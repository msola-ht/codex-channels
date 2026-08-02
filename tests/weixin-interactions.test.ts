import type { Logger } from "pino";
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
  it("remains reusable after transient interactions are cancelled", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "reusable-token",
    );
    const first = port.request(target, approvalRequest({
      requestId: "request-before-disconnect",
    }));
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
    });

    port.cancelAll("渠道连接已中断");
    await expect(first).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    const second = port.request(target, approvalRequest({
      requestId: "request-after-recovery",
    }));
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledTimes(2);
    });

    port.cancelAll();
    await second;
  });

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
        expect.arrayContaining([
          expect.stringContaining(
            "```text\n/批准一次 opaque-token\n```",
          ),
        ]),
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
      "Codex 交互已处理：已批准一次。",
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
    expect(prompt).toEqual(expect.arrayContaining([
      expect.stringContaining("/批准一次 display-token"),
    ]));
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

  it("collects fixed and free answers before resolving user input", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "input-token",
    );
    const request = userInputRequest({
      questions: [
        {
          id: "environment",
          header: "环境",
          question: "请选择环境",
          options: ["测试", "正式"],
          allowOther: false,
          secret: false,
        },
        {
          id: "branch",
          header: "分支",
          question: "请输入分支",
          options: [],
          allowOther: true,
          secret: false,
        },
      ],
    });

    const pending = port.request(target, request);
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledWith(
        target,
        expect.arrayContaining([
          expect.stringContaining("/选择 input-token 1 1"),
        ]),
      );
    });
    expect(JSON.stringify(
      delivery.deliverTextSequence.mock.calls[0]?.[1],
    )).not.toContain("/填写 input-token 2");

    await port.handleText(
      target,
      actorId,
      "/填写 input-token 2 不能提前回答",
    );
    expect(delivery.deliverText).toHaveBeenLastCalledWith(
      target,
      "请先回答第 1 项。",
    );

    await port.handleText(target, actorId, "/选择 input-token 1 2");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(delivery.deliverTextSequence).toHaveBeenLastCalledWith(
      target,
      expect.arrayContaining([
        expect.stringContaining("问题 2/2：分支"),
        expect.stringContaining("/填写 input-token 2 在这里输入答案"),
      ]),
    );

    await port.handleText(
      target,
      actorId,
      "/填写 input-token 2 feature/weixin",
    );

    await expect(pending).resolves.toEqual({
      type: "user-input",
      answers: {
        environment: ["正式"],
        branch: ["feature/weixin"],
      },
    });
  });

  it("safely cancels when the next user-input question cannot be delivered", async () => {
    const delivery = deliveryFixture();
    delivery.deliverTextSequence
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("private upstream detail"));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      logger as unknown as Logger,
      () => "input-token",
    );
    const pending = port.request(target, userInputRequest({
      questions: [
        {
          id: "environment",
          header: "环境",
          question: "请选择环境",
          options: ["测试", "正式"],
          allowOther: false,
          secret: false,
        },
        {
          id: "branch",
          header: "分支",
          question: "请输入分支",
          options: [],
          allowOther: true,
          secret: false,
        },
      ],
    }));
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledTimes(1);
    });

    await expect(
      port.handleText(target, actorId, "/选择 input-token 1 1"),
    ).resolves.toBe("handled");
    await expect(pending).resolves.toEqual({
      type: "user-input",
      answers: {},
    });
    expect(delivery.deliverText).toHaveBeenLastCalledWith(
      target,
      "Codex 交互已处理：输入请求无法继续，已安全取消。",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-input",
        requestType: "user-input",
        errorType: "Error",
      }),
      "微信下一项输入请求发送失败",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      "private upstream detail",
    );
  });

  it("keeps invalid user answers pending and cancels secret questions", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "answer-token",
    );
    const pending = port.request(target, userInputRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
    });

    await port.handleText(
      target,
      actorId,
      "/填写 answer-token 1 未提供的选项",
    );
    expect(delivery.deliverText).toHaveBeenLastCalledWith(
      target,
      "回答无效，请使用当前问题提供的命令。",
    );
    port.cancelAll();
    await expect(pending).resolves.toEqual({
      type: "user-input",
      answers: {},
    });

    const secretPort = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
    );
    await expect(secretPort.request(target, userInputRequest({
      requestId: "secret-request",
      questions: [{
        id: "password",
        header: "密码",
        question: "请输入密码",
        options: [],
        allowOther: true,
        secret: true,
      }],
    }))).resolves.toEqual({
      type: "user-input",
      answers: {},
    });
    expect(delivery.deliverText).toHaveBeenLastCalledWith(
      target,
      "微信聊天无法安全填写敏感信息，本次输入请求已取消。",
    );
  });

  it("accepts one bounded JSON MCP form and rejects malformed content", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "form-token",
    );
    const pending = port.request(target, formElicitationRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledWith(
        target,
        expect.arrayContaining([
          expect.stringContaining("/提交表单 form-token"),
        ]),
      );
    });

    await port.handleText(
      target,
      actorId,
      "/提交表单 form-token not-json",
    );
    expect(delivery.deliverText).toHaveBeenLastCalledWith(
      target,
      "MCP 交互命令或内容无效。",
    );
    await port.handleText(
      target,
      actorId,
      "/提交表单 form-token {\"project\":\"codex-channels\"}",
    );

    await expect(pending).resolves.toEqual({
      type: "elicitation",
      action: "accept",
      content: { project: "codex-channels" },
    });
  });

  it("renders and resolves MCP tool approval commands without asking for JSON", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "mcp-tool-token",
    );
    const pending = port.request(target, mcpToolApprovalRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledWith(
        target,
        expect.arrayContaining([
          expect.stringContaining("Update pull request"),
          expect.stringContaining("/批准一次 mcp-tool-token"),
          expect.stringContaining("/批准会话 mcp-tool-token"),
          expect.stringContaining("/始终允许 mcp-tool-token"),
        ]),
      );
    });
    expect(JSON.stringify(delivery.deliverTextSequence.mock.calls))
      .not.toContain("/提交表单");

    await port.handleText(
      target,
      actorId,
      "/批准会话 mcp-tool-token",
    );
    await expect(pending).resolves.toEqual({
      type: "elicitation",
      action: "accept",
      content: null,
      scope: "session",
    });
  });

  it("supports safe MCP URL completion and fails unsafe URLs closed", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "url-token",
    );
    const pending = port.request(target, elicitationRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledWith(
        target,
        expect.arrayContaining([
          expect.stringContaining("https://example.com/"),
          expect.stringContaining("/完成 url-token"),
        ]),
      );
    });
    await port.handleText(target, actorId, "/完成 url-token");
    await expect(pending).resolves.toEqual({
      type: "elicitation",
      action: "accept",
      content: null,
    });

    await expect(port.request(target, {
      ...elicitationRequest(),
      requestId: "unsafe-url",
      url: "javascript:alert(1)",
    })).resolves.toEqual({
      type: "elicitation",
      action: "cancel",
      content: null,
    });
    expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
  });

  it("cancels user input and invalidates MCP interaction resolved elsewhere", async () => {
    const delivery = deliveryFixture();
    const port = new WeixinInteractionPort(
      delivery,
      actorRegistryFixture([actorId]),
      accessFixture(true),
      undefined,
      () => "cancel-token",
    );
    const input = port.request(target, userInputRequest());
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledOnce();
    });
    await expect(port.handleText(
      target,
      actorId,
      "/取消 cancel-token",
    )).resolves.toBe("handled");
    await expect(input).resolves.toEqual({
      type: "user-input",
      answers: {},
    });

    const elicitation = port.request(target, {
      ...elicitationRequest(),
      requestId: "resolved-elsewhere",
    });
    await vi.waitFor(() => {
      expect(delivery.deliverTextSequence).toHaveBeenCalledTimes(2);
    });
    port.resolved("resolved-elsewhere");
    await expect(elicitation).resolves.toEqual({
      type: "elicitation",
      action: "cancel",
      content: null,
    });
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

function userInputRequest(
  overrides: Partial<
    Extract<InteractionRequest, { type: "user-input" }>
  > = {},
): Extract<InteractionRequest, { type: "user-input" }> {
  return {
    type: "user-input",
    requestId: "request-input",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    title: "Codex 需要补充信息",
    questions: [{
      id: "environment",
      header: "环境",
      question: "请选择环境",
      options: ["测试", "正式"],
      allowOther: false,
      secret: false,
    }],
    expiresInMs: 60_000,
    ...overrides,
  };
}

function elicitationRequest(): Extract<
  InteractionRequest,
  { type: "elicitation" }
> {
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

function formElicitationRequest(): Extract<
  InteractionRequest,
  { type: "elicitation" }
> {
  return {
    type: "elicitation",
    requestId: "request-elicitation",
    threadId: "thread",
    turnId: null,
    title: "title",
    message: "message",
    mode: "form",
    expiresInMs: 60_000,
  };
}

function mcpToolApprovalRequest(): Extract<
  InteractionRequest,
  { type: "elicitation" }
> {
  return {
    type: "elicitation",
    requestId: "request-mcp-tool",
    threadId: "thread",
    turnId: "turn",
    title: "MCP GitHub 请求批准",
    message: "允许 GitHub 更新拉取请求吗？",
    mode: "tool-approval",
    toolApproval: {
      toolTitle: "Update pull request",
      detail: "Pull request：146",
      allowSession: true,
      allowAlways: true,
    },
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
