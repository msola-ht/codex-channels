import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  conversationCommandNames,
  type ConversationUseCases,
} from "../src/application/index.js";
import { UserFacingError } from "../src/conversation-core/index.js";
import {
  FeishuConversationAdapter,
  FeishuOutbox,
  type FeishuInboxMessage,
} from "../src/surfaces/feishu/index.js";

const message: FeishuInboxMessage = {
  target: {
    surface: "feishu",
    accountId: "cli_0123456789abcdef",
    conversationId: "oc_chat",
  },
  actorId: "ou_actor",
  eventId: "event-1",
  messageId: "om_message",
  createdAtMs: 1_784_900_000_000,
  kind: "text",
  text: "继续开发",
};

const imagePort = {
  download: vi.fn(),
};

function createImageMessage(
  overrides: Partial<Extract<FeishuInboxMessage, { kind: "image" }>> = {},
): Extract<FeishuInboxMessage, { kind: "image" }> {
  return {
    target: message.target,
    actorId: message.actorId,
    eventId: message.eventId,
    messageId: message.messageId,
    createdAtMs: message.createdAtMs,
    kind: "image",
    imageKeys: ["img_v2_resource"],
    ...overrides,
  };
}

function createFileMessage(): Extract<FeishuInboxMessage, { kind: "file" }> {
  return {
    target: message.target,
    actorId: message.actorId,
    eventId: message.eventId,
    messageId: message.messageId,
    createdAtMs: message.createdAtMs,
    kind: "file",
    fileKey: "file_v2_resource",
    fileName: "settings.json",
  };
}

function createAudioMessage(): Extract<FeishuInboxMessage, { kind: "audio" }> {
  return {
    target: message.target,
    actorId: message.actorId,
    eventId: message.eventId,
    messageId: message.messageId,
    createdAtMs: message.createdAtMs,
    kind: "audio",
    fileKey: "file_v2_audio",
    durationMs: 12_000,
  };
}

describe("Feishu conversation adapter", () => {
  it("shows /vision delivery and Gateway handling latency", async () => {
    const fixture = createOutbox();
    const inputOptions = {
      quietWindowMs: 0,
      now: () => 1_450,
      debugEnabled: true,
    };
    const adapter = new FeishuConversationAdapter(
      {} as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      inputOptions,
    );

    await adapter.handle({
      ...message,
      text: "/vision 2 比较两张图片",
      createdAtMs: 1_000,
      receivedAtMs: 1_200,
    });
    await fixture.outbox.close();

    expect(fixture.sent[0]?.text).toContain("接收延迟：200毫秒");
    expect(fixture.sent[0]?.text).toContain("Gateway 处理：250毫秒");
  });

  it("hides /vision technical timing outside debug mode", async () => {
    const fixture = createOutbox();
    const adapter = new FeishuConversationAdapter(
      {} as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0, now: () => 1_450 },
    );

    await adapter.handle({
      ...message,
      text: "/vision 2 比较两张图片",
      createdAtMs: 1_000,
      receivedAtMs: 1_200,
    });
    await fixture.outbox.close();

    expect(fixture.sent[0]?.text).not.toContain("接收延迟");
    expect(fixture.sent[0]?.text).not.toContain("Gateway 处理");
  });

  it("uses rich posts for command results but keeps failures as plain text", async () => {
    const notifyMarkdown = vi.fn(() => true);
    const notifyText = vi.fn(() => true);
    const status = vi.fn(() => ({
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace",
      threadId: null,
      turnId: null,
      model: "gpt-test",
      effort: "medium",
      serviceTier: null,
      modelPending: false,
      effortPending: false,
      fastModePending: false,
      collaborationMode: "default",
      collaborationModePending: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { status } as unknown as ConversationUseCases,
      { notifyMarkdown, notifyText } as unknown as FeishuOutbox,
      imagePort,
    );

    await adapter.handle({ ...message, text: "/status" });
    await expect(
      adapter.handle({ ...message, text: "/unknown" }),
    ).rejects.toMatchObject({ code: "command.unsupported" });

    expect(notifyMarkdown).toHaveBeenCalledOnce();
    expect(notifyMarkdown).toHaveBeenCalledWith(
      "oc_chat",
      expect.stringContaining("Codex 状态"),
    );
    expect(notifyText).toHaveBeenCalledOnce();
    expect(notifyText).toHaveBeenCalledWith(
      "oc_chat",
      "操作失败：不支持该飞书命令，请发送 /help 查看可用命令。",
    );
  });

  it("handles Feishu-local help and identity commands without starting a Turn", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    for (const text of ["/start", "/help", "/whoami"]) {
      await adapter.handle({ ...message, text });
    }
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(fixture.sent).toHaveLength(3);
    expect(fixture.sent[0]?.text).toContain("飞书 Codex 命令");
    expect(fixture.sent[0]?.text).toContain("/status");
    expect(conversationCommandNames.every(
      (command) => fixture.sent[0]?.text.includes(`/${command}`),
    )).toBe(true);
    expect(fixture.sent[1]?.text).toBe(fixture.sent[0]?.text);
    expect(fixture.sent[2]?.text).toBe([
      "飞书身份",
      "用户 Open ID：ou_actor",
      "Chat ID：oc_chat",
      "App ID：cli_0123456789abcdef",
    ].join("\n"));
  });

  it("applies /vision to the next Feishu image only", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const download = vi.fn().mockResolvedValue({
      path: "/private/feishu/error.png",
      mimeType: "image/png",
      bytes: 10,
    });
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      { download },
    );

    await adapter.handle({ ...message, text: "/vision 分析报错原因" });
    await adapter.handle(createImageMessage());
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "分析报错原因",
      localImages: [{ path: "/private/feishu/error.png" }],
    });
    expect(fixture.sent.some((entry) =>
      entry.text.includes("图片识别要求已记录")
    )).toBe(true);
  });

  it("uses /stop to stop a pending interaction before stopping the active Turn", async () => {
    const fixture = createOutbox();
    const stop = vi.fn(async () => true);
    const stopForActor = vi.fn(() => true);
    const adapter = new FeishuConversationAdapter(
      { stop } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      { stopForActor },
    );

    await adapter.handle({ ...message, text: "/stop" });
    await fixture.outbox.close();

    expect(stopForActor).toHaveBeenCalledWith(message.target, message.actorId);
    expect(stop).not.toHaveBeenCalled();
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]?.text).toBe("已停止当前交互请求。");
  });

  it("uses /stop to stop the active Turn when no interaction is pending", async () => {
    const fixture = createOutbox();
    const stop = vi.fn(async () => true);
    const stopForActor = vi.fn(() => false);
    const adapter = new FeishuConversationAdapter(
      { stop } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      { stopForActor },
    );

    await adapter.handle({ ...message, text: "/stop" });
    await fixture.outbox.close();

    expect(stopForActor).toHaveBeenCalledWith(message.target, message.actorId);
    expect(stop).toHaveBeenCalledWith(message.target);
    expect(fixture.sent[0]?.text).toBe("已请求停止当前任务。");
  });

  it("opens the composed command center for start and help", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const open = vi.fn(async () => {});
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      { open },
    );

    await adapter.handle({ ...message, text: "/start" });
    await adapter.handle({ ...message, text: "/help" });
    await fixture.outbox.close();

    expect(open).toHaveBeenNthCalledWith(
      1,
      message.target,
      message.actorId,
    );
    expect(open).toHaveBeenNthCalledWith(
      2,
      message.target,
      message.actorId,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual([]);
  });

  it("provides concise Feishu status and doctor commands without starting a Turn", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      () => ({
        connectionReady: true,
        cardActionObserved: false,
        menuEventObserved: false,
      }),
    );

    for (const text of [
      "/fs",
      "/fs status",
      "/fs doctor",
      "/fs unknown",
    ]) {
      await adapter.handle({ ...message, text });
    }
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(fixture.sent).toHaveLength(4);
    expect(fixture.sent[0]?.text).toContain("飞书权限中心");
    expect(fixture.sent[0]?.text).toContain("/fs doctor");
    expect(fixture.sent[1]?.text).toContain("长连接：已就绪");
    expect(fixture.sent[1]?.text).toContain("卡片动作回调：尚未验证");
    expect(fixture.sent[2]?.text).toContain("✅ 长连接");
    expect(fixture.sent[2]?.text).toContain("✅ 消息接收");
    expect(fixture.sent[2]?.text).toContain(
      "◯ 卡片交互：待使用验证",
    );
    expect(fixture.sent[2]?.text).toContain(
      "◯ 自定义菜单：待点击验证",
    );
    expect(fixture.sent[2]?.text).not.toContain("OAuth");
    expect(fixture.sent[2]?.text).not.toContain("token");
    expect(fixture.sent[2]?.text).not.toContain("secret");
    expect(fixture.sent[3]?.text).toBe(
      "用法：/fs <status|doctor|revoke>",
    );
  });

  it("reuses Feishu-local identity, status, and doctor from command cards", async () => {
    const fixture = createOutbox();
    const openDoctor = vi.fn(async () => {});
    const adapter = new FeishuConversationAdapter(
      {} as ConversationUseCases,
      fixture.outbox,
      imagePort,
      () => ({
        connectionReady: true,
        cardActionObserved: true,
        menuEventObserved: true,
      }),
      {
        beginAuthorization: () => "started",
        status: async () => "valid",
        revoke: async () => false,
      },
      undefined,
      { openDoctor },
    );

    await adapter.handleCommandCenterAction(
      message.target,
      "whoami",
      message.actorId,
    );
    await adapter.handleCommandCenterAction(
      message.target,
      "feishu-status",
      message.actorId,
    );
    await adapter.handleCommandCenterAction(
      message.target,
      "feishu-doctor",
      message.actorId,
    );
    await fixture.outbox.close();

    expect(fixture.sent[0]?.text).toContain("用户 Open ID：ou_actor");
    expect(fixture.sent[1]?.text).toContain("长连接：已就绪");
    expect(openDoctor).toHaveBeenCalledWith(
      message.target,
      message.actorId,
      expect.objectContaining({ connectionReady: true }),
    );
  });

  it("returns clickable choices for selectable command-card actions", async () => {
    const fixture = createOutbox();
    const modelState = vi.fn(async () => ({
      models: [{
        id: "gpt-a",
        model: "gpt-a",
        displayName: "GPT A",
        supportedReasoningEfforts: [
          { effort: "medium", description: "平衡" },
          { effort: "high", description: "深入" },
        ],
        defaultReasoningEffort: "medium",
        serviceTiers: [{ id: "priority", name: "Fast" }],
        defaultServiceTier: "default",
        isDefault: true,
      }],
      model: "gpt-a",
      effort: "medium",
      serviceTier: "default",
      pending: false,
      modelPending: false,
      effortPending: false,
      serviceTierPending: false,
    }));
    const selectEffort = vi.fn(async () => ({
      ...(await modelState()),
      effort: "high",
    }));
    const adapter = new FeishuConversationAdapter(
      {
        modelState,
        selectEffort,
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    const choices = await adapter.handleCommandCenterAction(
      message.target,
      "effort",
      message.actorId,
      "",
    );
    expect(choices).toMatchObject({
      title: "选择思考强度",
      choices: [
        expect.objectContaining({ input: "medium" }),
        expect.objectContaining({ input: "high" }),
      ],
    });
    expect(fixture.sent).toEqual([]);

    await adapter.handleCommandCenterAction(
      message.target,
      "effort",
      message.actorId,
      "high",
    );
    await fixture.outbox.close();
    expect(selectEffort).toHaveBeenCalledWith(message.target, "high");
    expect(fixture.sent[0]?.text).toContain("当前思考强度：high");
  });

  it("uses the shared Skill list and explicit invocation commands", async () => {
    const fixture = createOutbox();
    const listSkills = vi.fn(async () => [{
      name: "systematic-debugging",
      description: "系统化排查",
    }]);
    const invokeSkill = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
      skillName: "systematic-debugging",
    }));
    const adapter = new FeishuConversationAdapter(
      {
        listSkills,
        invokeSkill,
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "skill",
      message.actorId,
    )).resolves.toBeUndefined();
    await adapter.handleCommandCenterAction(
      message.target,
      "skill",
      message.actorId,
      "systematic-debugging 排查断线",
    );
    await fixture.outbox.close();

    expect(invokeSkill).toHaveBeenCalledWith(
      message.target,
      "systematic-debugging",
      "排查断线",
    );
    expect(fixture.sent[0]?.text).toContain("1. systematic-debugging");
    expect(fixture.sent[1]?.text).toContain("已使用 Skill 开始任务");
  });

  it("turns active and archived session results into exact card choices", async () => {
    const fixture = createOutbox();
    const sessions = [{
      id: "thread-active",
      name: "当前会话",
      preview: "",
      cwd: "/workspace",
      updatedAt: 1,
      model: "gpt-test",
    }];
    const archived = [{
      id: "thread-archived",
      name: "旧会话",
      preview: "",
      cwd: "/workspace",
      updatedAt: 1,
      model: "gpt-test",
    }];
    const adapter = new FeishuConversationAdapter(
      {
        listSessions: vi.fn(async (
          _target: typeof message.target,
          options?: { archived?: boolean },
        ) => options?.archived ? archived : sessions),
        status: vi.fn(() => ({
          threadId: "thread-active",
          workspaceId: "workspace",
        })),
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "sessions",
      message.actorId,
    )).resolves.toMatchObject({
      title: "选择会话",
      choices: expect.arrayContaining([
        {
          label: "搜索会话…",
          action: "sessions-search",
          input: "",
        },
        {
          label: "✓ 当前会话 · 模型：gpt-test",
          action: "resume",
          input: "thread-active",
        },
      ]),
    });
    await expect(adapter.handleCommandCenterAction(
      message.target,
      "archived",
      message.actorId,
    )).resolves.toMatchObject({
      title: "恢复已归档会话",
      choices: [
        {
          label: "搜索归档…",
          action: "archived-search",
          input: "",
        },
        {
          label: "旧会话 · 模型：gpt-test",
          action: "unarchive",
          input: "thread-archived",
        },
      ],
    });
    await fixture.outbox.close();
  });

  it("keeps session search inside cards and returns clickable results", async () => {
    const fixture = createOutbox();
    const listSessions = vi.fn(async () => [{
      id: "thread-auth",
      name: "认证修复",
      preview: "",
      cwd: "/workspace",
      updatedAt: 1,
    }]);
    const adapter = new FeishuConversationAdapter(
      {
        listSessions,
        status: vi.fn(() => ({
          threadId: "thread-current",
          workspaceId: "workspace",
        })),
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "sessions-search",
      message.actorId,
    )).resolves.toMatchObject({
      kind: "form",
      action: "sessions",
    });
    await expect(adapter.handleCommandCenterAction(
      message.target,
      "sessions",
      message.actorId,
      "认证",
    )).resolves.toMatchObject({
      title: "选择会话",
      choices: expect.arrayContaining([
        { action: "resume", input: "thread-auth", label: "认证修复" },
      ]),
    });
    expect(listSessions).toHaveBeenCalledWith(message.target, {
      searchTerm: "认证",
    });
    await fixture.outbox.close();
  });

  it("keeps archived-session search inside cards", async () => {
    const fixture = createOutbox();
    const listSessions = vi.fn(async () => [{
      id: "thread-archived",
      name: "历史认证修复",
      preview: "",
      cwd: "/workspace",
      updatedAt: 1,
    }]);
    const adapter = new FeishuConversationAdapter(
      { listSessions } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "archived-search",
      message.actorId,
    )).resolves.toMatchObject({
      kind: "form",
      action: "archived",
    });
    await expect(adapter.handleCommandCenterAction(
      message.target,
      "archived",
      message.actorId,
      "认证",
    )).resolves.toMatchObject({
      title: "恢复已归档会话",
      choices: expect.arrayContaining([
        {
          action: "unarchive",
          input: "thread-archived",
          label: "历史认证修复",
        },
      ]),
    });
    expect(listSessions).toHaveBeenCalledWith(message.target, {
      archived: true,
      searchTerm: "认证",
    });
    await fixture.outbox.close();
  });

  it("reuses the command form for queued follow-up text", async () => {
    const fixture = createOutbox();
    const queueFollowUp = vi.fn(async () => ({ position: 1 }));
    const adapter = new FeishuConversationAdapter(
      { queueFollowUp } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "queue",
      message.actorId,
    )).resolves.toMatchObject({
      kind: "form",
      action: "queue",
      multiline: true,
    });
    await adapter.handleCommandCenterAction(
      message.target,
      "queue",
      message.actorId,
      "继续检查私聊失败路径",
    );
    await fixture.outbox.close();

    expect(queueFollowUp).toHaveBeenCalledWith(
      message.target,
      "继续检查私聊失败路径",
    );
    expect(fixture.sent[0]?.text).toContain("已排到下一 Turn");
  });

  it("offers only the existing safe project-rule actions", async () => {
    const fixture = createOutbox();
    const checkProjectRules = vi.fn(async () => ({
      projectRoot: "/workspace",
      rulesPath: "/workspace/.codex/rules/default.rules",
    }));
    const adapter = new FeishuConversationAdapter(
      { checkProjectRules } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "rules",
      message.actorId,
    )).resolves.toMatchObject({
      title: "项目规则",
      choices: [
        { action: "rules", input: "init" },
        { action: "rules", input: "check" },
      ],
    });
    await adapter.handleCommandCenterAction(
      message.target,
      "rules",
      message.actorId,
      "check",
    );
    await fixture.outbox.close();

    expect(checkProjectRules).toHaveBeenCalledWith(message.target);
    expect(fixture.sent[0]?.text).toContain("项目规则检查通过");
  });

  it("maps review cards back to the shared review command grammar", async () => {
    const fixture = createOutbox();
    const review = vi.fn(async () => ({
      threadId: "review-thread",
      turnId: "review-turn",
      steered: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { review } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "review",
      message.actorId,
    )).resolves.toMatchObject({
      title: "开始 Review",
      choices: [
        { action: "review", input: " " },
        { action: "review-branch", input: "" },
        { action: "review-commit", input: "" },
        { action: "review-custom", input: "" },
      ],
    });
    await expect(adapter.handleCommandCenterAction(
      message.target,
      "review-branch",
      message.actorId,
    )).resolves.toMatchObject({
      kind: "form",
      action: "review",
      inputPrefix: "branch ",
    });
    await adapter.handleCommandCenterAction(
      message.target,
      "review",
      message.actorId,
      "branch main",
    );
    await fixture.outbox.close();

    expect(review).toHaveBeenCalledWith(message.target, {
      type: "baseBranch",
      branch: "main",
    });
    expect(fixture.sent[0]?.text).toContain("已启动 Codex Review");
  });

  it("maps Goal choices and forms to the shared Goal command", async () => {
    const fixture = createOutbox();
    const setGoal = vi.fn(async (
      _target: typeof message.target,
      objective: string,
    ) => ({
      threadId: "thread-1",
      objective,
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 1,
    }));
    const adapter = new FeishuConversationAdapter(
      { setGoal } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "goal",
      message.actorId,
    )).resolves.toMatchObject({
      title: "Thread Goal",
      choices: [
        { action: "goal", input: " " },
        { action: "goal-set", input: "" },
        { action: "goal", input: "clear" },
      ],
    });
    await expect(adapter.handleCommandCenterAction(
      message.target,
      "goal-set",
      message.actorId,
    )).resolves.toMatchObject({
      kind: "form",
      action: "goal",
      inputPrefix: "set ",
    });
    await adapter.handleCommandCenterAction(
      message.target,
      "goal",
      message.actorId,
      "set 完成飞书私聊收口",
    );
    await fixture.outbox.close();

    expect(setGoal).toHaveBeenCalledWith(
      message.target,
      "完成飞书私聊收口",
    );
    expect(fixture.sent[0]?.text).toContain("Goal 已设置");
  });

  it("binds user authorization status and revoke to the current message actor", async () => {
    const fixture = createOutbox();
    const beginAuthorization = vi.fn(() => "started" as const);
    const status = vi.fn(async () => "valid" as const);
    const revoke = vi.fn(async () => true);
    const adapter = new FeishuConversationAdapter(
      {} as ConversationUseCases,
      fixture.outbox,
      imagePort,
      () => ({
        connectionReady: true,
        cardActionObserved: true,
        menuEventObserved: true,
      }),
      {
        beginAuthorization,
        status,
        revoke,
      },
    );

    await adapter.handle({ ...message, text: "/fs authorize" });
    await adapter.handle({ ...message, text: "/fs status" });
    await adapter.handle({ ...message, text: "/fs revoke" });
    await fixture.outbox.close();

    expect(beginAuthorization).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith("ou_actor");
    expect(revoke).toHaveBeenCalledWith("ou_actor");
    expect(fixture.sent).toEqual([
      {
        chatId: "oc_chat",
        text: "用法：/fs <status|doctor|revoke>",
      },
      expect.objectContaining({
        text: expect.stringContaining("当前用户 OAuth：已授权"),
      }),
      {
        chatId: "oc_chat",
        text: "已清除当前飞书账号保存的本地授权凭据。",
      },
    ]);
  });

  it("renders an in-progress Feishu user authorization", async () => {
    const fixture = createOutbox();
    const adapter = new FeishuConversationAdapter(
      {} as ConversationUseCases,
      fixture.outbox,
      imagePort,
      () => ({
        connectionReady: true,
        cardActionObserved: false,
        menuEventObserved: false,
      }),
      {
        beginAuthorization: () => "running",
        status: async () => "pending",
        revoke: async () => false,
      },
    );

    await adapter.handle({ ...message, text: "/fs status" });
    await fixture.outbox.close();

    expect(fixture.sent[0]?.text).toContain("当前用户 OAuth：授权进行中");
  });

  it("fails closed when permission runtime status is not composed", async () => {
    const fixture = createOutbox();
    const adapter = new FeishuConversationAdapter(
      {} as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await adapter.handle({ ...message, text: "/fs status" });
    await fixture.outbox.close();

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]?.chatId).toBe("oc_chat");
    expect(fixture.sent[0]?.text).toContain("长连接：未就绪");
  });

  it("rejects an unknown slash command instead of submitting it as model input", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    for (const text of [
      "/unknown",
      "/unknown-command",
      "/feishu status",
      "/STATUS",
      "/",
    ]) {
      await expect(
        adapter.handle({ ...message, text }),
      ).rejects.toMatchObject({ code: "command.unsupported" });
    }
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual(Array.from({ length: 5 }, () => ({
      chatId: "oc_chat",
      text: "操作失败：不支持该飞书命令，请发送 /help 查看可用命令。",
    })));
  });

  it("routes an authorized status command through Application instead of starting a Turn", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const status = vi.fn(() => ({
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace",
      threadId: "thread-1",
      turnId: "turn-1",
      model: "gpt-test",
      effort: "medium",
      serviceTier: "priority",
      modelPending: false,
      effortPending: false,
      fastModePending: false,
      collaborationMode: "default",
      collaborationModePending: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit, status } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await adapter.handle({ ...message, text: "/status" });
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(message.target, {
      includeGitBranch: true,
    });
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: [
        "Codex 状态",
        "Workspace：Main (main)",
        "Thread：thread-1",
        "Turn：turn-1",
        "工作目录：/workspace",
        "Git 分支：未检测到",
        "模型：gpt-test",
        "提供商：OpenAI",
        "思考强度：medium",
        "Fast 模式：开启",
        "协作模式：Default",
        "",
        "当前 Thread 用量：等待 App Server 推送统计",
      ].join("\n"),
    }]);
  });

  it("forwards command arguments through the shared Application command service", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const queueFollowUp = vi.fn(async () => ({
      threadId: "thread-1",
      position: 2,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit, queueFollowUp } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await adapter.handle({ ...message, text: "/queue 继续检查参数" });
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(queueFollowUp).toHaveBeenCalledWith(
      message.target,
      "继续检查参数",
    );
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "已排到下一 Turn，当前第 2 条。队列仅保存在内存，Gateway 重启会清空。",
    }]);
  });

  it("reports output queue rejection after a state-changing command without retrying it", async () => {
    const newSession = vi.fn(async () => undefined);
    const notifyText = vi.fn(() => false);
    const adapter = new FeishuConversationAdapter(
      { newSession } as unknown as ConversationUseCases,
      { notifyText } as unknown as FeishuOutbox,
      imagePort,
    );

    await expect(
      adapter.handle({ ...message, text: "/new" }),
    ).rejects.toMatchObject({ name: "FeishuOutputQueueError" });

    expect(newSession).toHaveBeenCalledTimes(1);
    expect(notifyText).toHaveBeenCalledTimes(1);
  });

  it("submits an accepted private text message to Application", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handle(message)).resolves.toBeUndefined();
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledWith(message.target, "继续开发");
    expect(fixture.sent).toEqual([]);
  });

  it("resolves a Feishu reply parent as separated quoted context", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const readQuotedText = vi.fn(async () => "原始消息");
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0, readQuotedText },
    );

    await adapter.handle({
      ...message,
      parentId: "om_parent",
      text: "这句话是什么意思？",
    });
    await fixture.outbox.close();

    expect(readQuotedText).toHaveBeenCalledWith("om_parent");
    expect(submit).toHaveBeenCalledWith(message.target, [
      "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：",
      "> 原始消息",
      "",
      "当前消息：",
      "这句话是什么意思？",
    ].join("\n"));
  });

  it("submits the current Feishu message when quoted text cannot be read", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const error = new Error("private upstream detail");
    const onQuotedTextError = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        quietWindowMs: 0,
        readQuotedText: async () => {
          throw error;
        },
        onQuotedTextError,
      },
    );

    await adapter.handle({
      ...message,
      parentId: "om_parent",
      text: "只处理当前消息",
    });
    await fixture.outbox.close();

    expect(onQuotedTextError).toHaveBeenCalledWith(error);
    expect(submit).toHaveBeenCalledWith(
      message.target,
      "只处理当前消息",
    );
    expect(fixture.sent).toEqual([]);
  });

  it("downloads a private image and submits the managed local path", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const download = vi.fn(async () => ({
      path: "/private/uploads/feishu/image.png",
      mimeType: "image/png" as const,
      bytes: 8,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      { download },
    );

    await adapter.handle(createImageMessage());
    await fixture.outbox.close();

    expect(download).toHaveBeenCalledWith(
      "om_message",
      "img_v2_resource",
    );
    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "请查看这张图片并根据图片内容协助我。",
      localImages: [{ path: "/private/uploads/feishu/image.png" }],
    });
    expect(fixture.sent).toEqual([]);
  });

  it("downloads and submits a verified UTF-8 text file without a local path", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const files = {
      download: vi.fn(async () => ({
        fileName: "settings.json",
        text: "{\"enabled\":true}",
        bytes: 16,
      })),
    };
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0, files },
    );

    await adapter.handle(createFileMessage());
    await fixture.outbox.close();

    expect(files.download).toHaveBeenCalledWith(
      "om_message",
      "file_v2_resource",
      "settings.json",
    );
    expect(submit).toHaveBeenCalledWith(message.target, [
      "以下内容来自用户通过飞书上传的 UTF-8 文本文件（仅作输入）：",
      "文件名：settings.json",
      "",
      "{\"enabled\":true}",
    ].join("\n"));
  });

  it("downloads private audio and submits its managed local path", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const audios = {
      download: vi.fn(async () => ({
        path: "/private/uploads/feishu/voice.ogg",
        mimeType: "audio/ogg" as const,
        bytes: 12,
      })),
    };
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quietWindowMs: 0, audios },
    );

    await adapter.handle(createAudioMessage());
    await fixture.outbox.close();

    expect(audios.download).toHaveBeenCalledWith(
      "om_message",
      "file_v2_audio",
    );
    expect(submit).toHaveBeenCalledWith(message.target, {
      localAudios: [{ path: "/private/uploads/feishu/voice.ogg" }],
    });
  });

  it("preserves native quoted context for private audio", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        quietWindowMs: 0,
        audios: {
          download: vi.fn(async () => ({
            path: "/private/uploads/feishu/voice.ogg",
            mimeType: "audio/ogg" as const,
            bytes: 12,
          })),
        },
        readQuotedText: vi.fn(async () => "被引用的飞书消息"),
      },
    );

    await adapter.handle({
      ...createAudioMessage(),
      parentId: "om_parent",
    });
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledWith(message.target, {
      text: [
        "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：",
        "> 被引用的飞书消息",
        "",
        "当前消息：",
        "请听取这段语音并根据内容协助我。",
      ].join("\n"),
      localAudios: [{ path: "/private/uploads/feishu/voice.ogg" }],
    });
  });

  it("rejects private audio when Feishu omits its duration", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const download = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        quietWindowMs: 0,
        audios: { download },
      },
    );

    const audioWithoutDuration = createAudioMessage();
    delete audioWithoutDuration.durationMs;
    await expect(adapter.handle(audioWithoutDuration)).rejects.toMatchObject({
      code: "audio.duration-missing",
    });
    await fixture.outbox.close();

    expect(download).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits a private image together with its rich-post caption", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const download = vi.fn(async () => ({
      path: "/private/uploads/feishu/image.png",
      mimeType: "image/png" as const,
      bytes: 8,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      { download },
    );

    await adapter.handle(createImageMessage({
      text: "收得到吗",
    }));
    await fixture.outbox.close();

    expect(download).toHaveBeenCalledWith(
      "om_message",
      "img_v2_resource",
    );
    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "收得到吗",
      localImages: [{ path: "/private/uploads/feishu/image.png" }],
    });
    expect(fixture.sent).toEqual([]);
  });

  it("submits adjacent private images as one ordered multi-image input", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: "/private/uploads/feishu/first.png",
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockResolvedValueOnce({
        path: "/private/uploads/feishu/second.jpg",
        mimeType: "image/jpeg" as const,
        bytes: 9,
      });
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      { download },
    );

    await adapter.handleImageBatch([
      createImageMessage({
        messageId: "om_first",
        imageKeys: ["img_v2_first"],
        text: "比较这些图片",
      }),
      createImageMessage({
        eventId: "event-2",
        messageId: "om_second",
        imageKeys: ["img_v2_second"],
      }),
    ]);
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "比较这些图片",
      localImages: [
        { path: "/private/uploads/feishu/first.png" },
        { path: "/private/uploads/feishu/second.jpg" },
      ],
    });
    expect(fixture.sent).toEqual([]);
  });

  it("automatically submits a sized collection from adjacent Feishu images", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: "/private/uploads/feishu/first.png",
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockResolvedValueOnce({
        path: "/private/uploads/feishu/second.jpg",
        mimeType: "image/jpeg" as const,
        bytes: 9,
      });
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      { download },
    );

    await adapter.handle({ ...message, text: "/vision 2 比较这些图片" });
    await adapter.handleImageBatch([
      createImageMessage({
        messageId: "om_first",
        imageKeys: ["img_v2_first"],
      }),
      createImageMessage({
        eventId: "event-2",
        messageId: "om_second",
        imageKeys: ["img_v2_second"],
      }),
    ]);
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "比较这些图片",
      localImages: [
        { path: "/private/uploads/feishu/first.png" },
        { path: "/private/uploads/feishu/second.jpg" },
      ],
    });
    expect(fixture.sent.some((entry) =>
      entry.text.includes("图片已收齐")
    )).toBe(true);
  });

  it("submits multiple images from one rich post in their original order", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const download = vi.fn()
      .mockResolvedValueOnce({
        path: "/private/uploads/feishu/first.png",
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockResolvedValueOnce({
        path: "/private/uploads/feishu/second.jpg",
        mimeType: "image/jpeg" as const,
        bytes: 9,
      });
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
      fixture.outbox,
      { download },
    );

    await adapter.handle(createImageMessage({
      imageKeys: ["img_v2_first", "img_v2_second"],
      text: "飞书多图发送测试",
    }));
    await fixture.outbox.close();

    expect(download.mock.calls).toEqual([
      ["om_message", "img_v2_first"],
      ["om_message", "img_v2_second"],
    ]);
    expect(submit).toHaveBeenCalledWith(message.target, {
      text: "飞书多图发送测试",
      localImages: [
        { path: "/private/uploads/feishu/first.png" },
        { path: "/private/uploads/feishu/second.jpg" },
      ],
    });
    expect(fixture.sent).toEqual([]);
  });

  it("rejects more than four adjacent images before downloading", async () => {
    const fixture = createOutbox();
    const download = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit: vi.fn() } as unknown as ConversationUseCases,
      fixture.outbox,
      { download },
    );

    await expect(adapter.handleImageBatch(
      Array.from({ length: 5 }, (_, index) => createImageMessage({
        eventId: `event-${index}`,
        messageId: `om_${index}`,
        imageKeys: [`img_v2_${index}`],
      })),
    )).rejects.toMatchObject({ code: "image.too-many" });
    await fixture.outbox.close();

    expect(download).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "操作失败：一次最多处理 4 张图片。",
    }]);
  });

  it("uses a distinct confirmation when an image steers the active Turn", async () => {
    const fixture = createOutbox();
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => ({
          threadId: "thread-1",
          turnId: "turn-1",
          steered: true,
        }),
      } as unknown as ConversationUseCases,
      fixture.outbox,
      {
        download: async () => ({
          path: "/private/uploads/feishu/image.jpg",
          mimeType: "image/jpeg",
          bytes: 3,
        }),
      },
    );

    await adapter.handle(createImageMessage({
      imageKeys: ["img_resource"],
    }));
    await fixture.outbox.close();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "已将图片追加到当前 Turn。",
    }]);
  });

  it("confirms when the message was added to the active Turn", async () => {
    const fixture = createOutbox();
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => ({
          threadId: "thread-1",
          turnId: "turn-1",
          steered: true,
        }),
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await adapter.handle(message);
    await fixture.outbox.close();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "已将补充要求追加到当前 Turn。",
    }]);
  });

  it("renders a structured user error without exposing its fallback message", async () => {
    const fixture = createOutbox();
    const failure = new UserFacingError(
      "thread.bound",
      "opaque upstream detail",
    );
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => {
          throw failure;
        },
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handle(message)).rejects.toBe(failure);
    await fixture.outbox.close();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "操作失败：该 Codex Thread 已绑定到其他会话。",
    }]);
    expect(JSON.stringify(fixture.sent)).not.toContain("opaque");
  });

  it("hides an unknown internal error and returns it to the Inbox diagnostic path", async () => {
    const fixture = createOutbox();
    const failure = new Error("Authorization: secret");
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => {
          throw failure;
        },
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handle(message)).rejects.toBe(failure);
    await fixture.outbox.close();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "操作失败：Gateway 未能完成请求，请稍后重试。",
    }]);
    expect(JSON.stringify(fixture.sent)).not.toContain("secret");
  });
});

function createOutbox(): {
  outbox: FeishuOutbox;
  sent: Array<{ chatId: string; text: string }>;
} {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    outbox: new FeishuOutbox(
      message.target.accountId,
      {
        sendCard: async () => "om_card",
        updateCard: async () => {},
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        sendPost: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        sendMarkdownCard: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        createStreamingCard: async () => ({
          cardId: "735537276613415731",
          messageId: "om_stream",
        }),
        updateStreamingCard: async () => {},
        finishStreamingCard: async () => {},
      },
      pino({ level: "silent" }),
    ),
  };
}
