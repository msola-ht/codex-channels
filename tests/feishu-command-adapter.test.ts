import { describe, expect, it, vi } from "vitest";

import {
  conversationCommandNames,
  type ScheduledTaskConfirmation,
} from "../src/application/index.js";
import { UserFacingError } from "../src/conversation-core/index.js";
import { FeishuOutbox } from "../src/surfaces/feishu/index.js";
import {
  conversationSession,
  conversationStatus,
  modelOption,
  modelSelectionState,
} from "./conversation-command-fixture.js";
import {
  createOutbox,
  FeishuConversationAdapter,
  imagePort,
  message,
} from "./feishu-adapter-test-fixture.js";

describe("Feishu command adapter", () => {
  it("uses rich posts for command results but keeps failures as plain text", async () => {
    const notifyMarkdown = vi.fn(() => true);
    const notifyText = vi.fn(() => true);
    const status = vi.fn(() => conversationStatus({
      model: "gpt-test",
      effort: "medium",
    }));
    const adapter = new FeishuConversationAdapter(
      { status },
      { notifyMarkdown, notifyText } as unknown as FeishuOutbox,
      imagePort,
    );

    await adapter.handle({ ...message, text: "/status" });
    status.mockImplementationOnce(() => {
      throw new UserFacingError(
        "command.unsupported",
        "飞书命令不受支持",
      );
    });
    await expect(
      adapter.handle({ ...message, text: "/status" }),
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
    const touchActivity = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit, touchActivity },
      fixture.outbox,
      imagePort,
    );

    for (const text of ["/start", "/help", "/whoami"]) {
      await adapter.handle({ ...message, text });
    }
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(touchActivity).toHaveBeenCalledTimes(3);
    expect(touchActivity).toHaveBeenCalledWith(message.target);
    expect(fixture.sent).toHaveLength(3);
    expect(fixture.sent[0]?.text).toContain("飞书 Codex 命令");
    expect(fixture.sent[0]?.text).toContain("/status");
    expect(conversationCommandNames.every(
      (command) => fixture.sent[0]?.text.includes(`/${command}`),
    )).toBe(true);
    expect(fixture.sent[1]?.text).toBe(fixture.sent[0]?.text);
    expect(fixture.sent[2]?.text).toBe([
      "## 飞书身份",
      "- 用户 Open ID：ou_actor",
      "- Chat ID：oc_chat",
      "- App ID：cli_0123456789abcdef",
    ].join("\n"));
  });

  it("uses /stop to stop a pending interaction before stopping the active Turn", async () => {
    const fixture = createOutbox();
    const stop = vi.fn(async () => true);
    const stopForActor = vi.fn(() => true);
    const adapter = new FeishuConversationAdapter(
      { stop },
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
      { stop },
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
    expect(fixture.sent[0]?.text).toBe("## 已请求停止当前任务。");
  });

  it("opens the composed command center for start and help", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const open = vi.fn(async () => {});
    const openResponse = vi.fn(async () => {});
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      { open, openResponse },
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

  it("opens a native confirmation card for a directly typed schedule preview", async () => {
    const fixture = createOutbox();
    const openResponse = vi.fn(async () => {});
    const task = {
      taskId: "task-preview",
      name: "每小时检查",
      status: "active" as const,
      schedule: { type: "interval" as const, intervalMinutes: 60, anchorAt: 1 },
      timezone: "Asia/Shanghai",
      nextRunAt: 2,
      workspaceId: "main",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      sandbox: "workspace-write" as const,
      permissions: null,
      promptPreview: "检查项目",
    };
    const previewNaturalLanguage = vi.fn(() => ({
      action: "create" as const,
      token: "12345678-1234-1234-1234-123456789abc",
      expiresAt: Date.now() + 60_000,
      task,
    }));
    const adapter = new FeishuConversationAdapter(
      {},
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      { open: vi.fn(async () => {}), openResponse } as never,
      undefined,
      undefined,
      { scheduledTasks: { previewNaturalLanguage } as never },
    );

    await adapter.handle({
      ...message,
      text: "/schedule 每隔 1 小时在 Asia/Shanghai 检查项目",
    });
    await fixture.outbox.close();

    expect(openResponse).toHaveBeenCalledWith(
      message.target,
      message.actorId,
      expect.objectContaining({
        title: "确认创建计划任务",
        choices: expect.arrayContaining([
          expect.objectContaining({
            label: "确认",
            input: "confirm 12345678-1234-1234-1234-123456789abc",
          }),
          expect.objectContaining({ label: "取消" }),
        ]),
      }),
    );
    expect(fixture.sent).toEqual([]);
  });

  it("opens the native CardKit confirmation for a schedule_task preview", async () => {
    const fixture = createOutbox();
    const openResponse = vi.fn(async () => {});
    const adapter = new FeishuConversationAdapter(
      {},
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      { open: vi.fn(async () => {}), openResponse } as never,
    );
    const preview = scheduledTaskPreview();

    await adapter.presentScheduledTaskConfirmation(
      message.target,
      message.actorId,
      preview,
    );
    await fixture.outbox.close();

    expect(openResponse).toHaveBeenCalledWith(
      message.target,
      message.actorId,
      expect.objectContaining({
        title: "确认创建计划任务",
        descriptionFormat: "markdown",
        choices: expect.arrayContaining([
          expect.objectContaining({
            label: "确认",
            input: `confirm ${preview.token}`,
          }),
          expect.objectContaining({ label: "取消" }),
        ]),
      }),
    );
  });

  it("provides concise Feishu status and doctor commands without starting a Turn", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const adapter = new FeishuConversationAdapter(
      { submit },
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
    expect(fixture.sent[2]?.text).toContain("长连接：已就绪");
    expect(fixture.sent[2]?.text).toContain("消息接收：已验证");
    expect(fixture.sent[2]?.text).toContain(
      "卡片交互：待使用验证",
    );
    expect(fixture.sent[2]?.text).toContain(
      "自定义菜单：待点击验证",
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
      {},
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
    const modelState = vi.fn(async () => modelSelectionState({
      models: [modelOption({
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
      })],
      model: "gpt-a",
      modelProvider: "openai",
      providerFilter: "openai",
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
    const selectModel = vi.fn(async () => ({
      ...(await modelState()),
      pending: true,
      modelPending: true,
      effortPending: true,
    }));
    const adapter = new FeishuConversationAdapter(
      {
        modelState,
        selectModel,
        selectEffort,
      },
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
      title: "选择思考等级",
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
    expect(fixture.sent[0]?.text).toContain("当前思考等级：high");

    const followUp = await adapter.handleCommandCenterAction(
      message.target,
      "model",
      message.actorId,
      "1",
    );
    expect(selectModel).toHaveBeenCalledWith(message.target, "1");
    expect(followUp).toMatchObject({
      title: "选择思考等级",
      choices: [
        expect.objectContaining({ action: "effort", input: "medium" }),
        expect.objectContaining({ action: "effort", input: "high" }),
      ],
    });
  });

  it("renders provider choices before any provider is chosen", async () => {
    const fixture = createOutbox();
    const modelState = vi.fn(async () => modelSelectionState({
      models: [
        modelOption({
          id: "gpt-test",
          model: "gpt-test",
          provider: "openai",
          displayName: "GPT Test",
          supportedReasoningEfforts: [{ effort: "medium", description: "平衡" }],
          defaultReasoningEffort: "medium",
          serviceTiers: [{ id: "priority", name: "Fast" }],
          defaultServiceTier: "priority",
          isDefault: true,
        }),
        modelOption({
          id: "deepseek-v4",
          model: "deepseek-v4",
          provider: "deepseek",
          displayName: "DeepSeek V4",
          supportedReasoningEfforts: [{ effort: "high", description: "深入" }],
          defaultReasoningEffort: "high",
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
        }),
      ],
      model: "gpt-test",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: "priority",
      pending: false,
      modelPending: false,
      effortPending: false,
      serviceTierPending: true,
    }));
    const clearModelBrowse = vi.fn(async () => (await modelState()));
    const adapter = new FeishuConversationAdapter(
      { modelState, clearModelBrowse },
      fixture.outbox,
      imagePort,
    );

    const response = await adapter.handleCommandCenterAction(
      message.target,
      "model",
      message.actorId,
      "",
    );
    expect(response).toMatchObject({
      title: "选择提供商",
      descriptionFormat: "markdown",
    });
    if (response === undefined || "kind" in response) {
      throw new Error("预期返回选择卡片");
    }
    expect(response.description).toContain("Fast 模式：开启（下一次 Turn 生效）");
    expect(response.choices).toEqual([
      expect.objectContaining({ action: "model", input: "openai" }),
      expect.objectContaining({ action: "model", input: "deepseek" }),
    ]);
    await fixture.outbox.close();
  });

  it("opens a reasoning-effort card after a directly typed model selection", async () => {
    const fixture = createOutbox();
    const openResponse = vi.fn(async () => {});
    const selectModel = vi.fn(async () => modelSelectionState({
      models: [modelOption({
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        supportedReasoningEfforts: [
          { effort: "medium", description: "平衡" },
          { effort: "high", description: "深入" },
        ],
        defaultReasoningEffort: "medium",
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
      })],
      model: "gpt-test",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: null,
      pending: true,
      modelPending: true,
      effortPending: true,
      serviceTierPending: false,
    }));
    const modelState = vi.fn(async () => modelSelectionState({
      providerFilter: "openai",
    }));
    const adapter = new FeishuConversationAdapter(
      { modelState, selectModel },
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      { open: vi.fn(async () => {}), openResponse } as never,
    );

    await adapter.handle({ ...message, text: "/model 1" });
    await fixture.outbox.close();

    expect(openResponse).toHaveBeenCalledWith(
      message.target,
      message.actorId,
      expect.objectContaining({ title: "选择思考等级" }),
    );
    expect(fixture.sent).toEqual([]);
  });

  it("opens the provider model choices card after selecting a provider", async () => {
    const fixture = createOutbox();
    const modelState = vi.fn(async () => modelSelectionState({
      models: [modelOption({
        id: "deepseek-v4",
        model: "deepseek-v4",
        provider: "deepseek",
        displayName: "DeepSeek · DeepSeek V4",
        supportedReasoningEfforts: [{ effort: "high", description: "深入" }],
        defaultReasoningEffort: "high",
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
      })],
      model: "deepseek-v4",
      modelProvider: "deepseek",
      providerFilter: "deepseek",
      effort: "high",
      serviceTier: null,
      pending: false,
      modelPending: false,
      effortPending: false,
      serviceTierPending: false,
    }));
    const selectModel = vi.fn(async () => {
      throw new UserFacingError("model.selector.not-found", "找不到指定模型");
    });
    const browseProviderModels = vi.fn(async () => modelState());
    const adapter = new FeishuConversationAdapter(
      { modelState, selectModel, browseProviderModels },
      fixture.outbox,
      imagePort,
    );

    const response = await adapter.handleCommandCenterAction(
      message.target,
      "model",
      message.actorId,
      "deepseek",
    );

    expect(response).toMatchObject({ title: "选择模型" });
    if (response === undefined || "kind" in response) {
      throw new Error("预期返回选择卡片");
    }
    expect(response.choices).toEqual([
      expect.objectContaining({
        action: "model",
        input: "deepseek-v4",
        label: "✓ DeepSeek V4",
      }),
    ]);
    expect(fixture.sent).toEqual([]);
    await fixture.outbox.close();
  });

  it("adds related action shortcuts to the Feishu status card", async () => {
    const fixture = createOutbox();
    const adapter = new FeishuConversationAdapter(
      {
        status: vi.fn(() => conversationStatus({
          threadId: "thread-1",
          model: "gpt-test",
          modelProvider: "openai",
          effort: "medium",
        })),
      },
      fixture.outbox,
      imagePort,
    );

    const response = await adapter.handleCommandCenterAction(
      message.target,
      "status",
      message.actorId,
      "",
    );

    expect(response).toMatchObject({
      title: "Codex 状态",
      descriptionFormat: "markdown",
      choices: expect.arrayContaining([
        { label: "模型设置", action: "model", input: "" },
        { label: "工作区", action: "workspace", input: "" },
        { label: "权限查询", action: "permissions", input: "" },
      ]),
    });
    await fixture.outbox.close();
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
      },
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
    expect(fixture.sent).toHaveLength(1);
  });

  it("turns workspace permission updates into clickable card choices", async () => {
    const fixture = createOutbox();
    const updateWorkspacePermissions = vi.fn(async () => ({
      id: "codex-connect",
      name: "Workspace",
      cwd: "/workspace",
      approvalPolicy: "never" as const,
    }));
    const adapter = new FeishuConversationAdapter(
      {
        status: () => conversationStatus({ workspaceId: "codex-connect" }),
        listWorkspaces: () => [{
          id: "codex-connect",
          name: "Workspace",
          cwd: "/workspace",
          sandbox: "read-only" as const,
        }],
        updateWorkspacePermissions,
      },
      fixture.outbox,
      imagePort,
    );

    const first = await adapter.handleCommandCenterAction(
      message.target,
      "workspaceperm",
      message.actorId,
      "",
    );
    expect(first).toMatchObject({
      title: "工作区权限",
      choices: [
        expect.objectContaining({ input: "sandbox" }),
        expect.objectContaining({ input: "approval" }),
        expect.objectContaining({ action: "workspace-perm-profile" }),
      ],
    });

    const second = await adapter.handleCommandCenterAction(
      message.target,
      "workspaceperm",
      message.actorId,
      "sandbox",
    );
    expect(second).toMatchObject({
      title: "选择沙箱模式",
      choices: expect.arrayContaining([
        expect.objectContaining({ input: "sandbox read-only" }),
        expect.objectContaining({ input: "sandbox danger-full-access" }),
      ]),
    });

    const profileForm = await adapter.handleCommandCenterAction(
      message.target,
      "workspace-perm-profile",
      message.actorId,
      "",
    );
    expect(profileForm).toMatchObject({
      kind: "form",
      action: "workspaceperm",
      inputPrefix: "profile ",
    });

    await adapter.handleCommandCenterAction(
      message.target,
      "workspaceperm",
      message.actorId,
      "approval never",
    );
    await fixture.outbox.close();
    expect(updateWorkspacePermissions).toHaveBeenCalledWith(message.target, {
      kind: "approval",
      value: "never",
    });
    expect(fixture.sent[0]?.text).toContain("已更新工作区权限");
  });

  it("adds a read-only permissions result entry point to Workspace settings", async () => {
    const fixture = createOutbox();
    const adapter = new FeishuConversationAdapter(
      {
        status: () => conversationStatus({ workspaceId: "codex-connect" }),
        listWorkspaces: () => [{
          id: "codex-connect",
          name: "Workspace",
          cwd: "/workspace",
        }],
        listPermissionProfiles: async () => [{
          id: ":workspace",
          description: "允许工作区写入",
          allowed: true,
        }],
      },
      fixture.outbox,
      imagePort,
    );

    const result = await adapter.handleCommandCenterAction(
      message.target,
      "permissions",
      message.actorId,
      "",
    );
    expect(result).toMatchObject({
      title: "权限只读查询",
      description: expect.stringContaining("本次为只读查询"),
      descriptionFormat: "markdown",
      choices: [{
        label: "修改 Workspace 权限",
        action: "workspaceperm",
        input: "",
      }],
    });
    await fixture.outbox.close();
  });

  it("turns active and archived session results into exact card choices", async () => {
    const fixture = createOutbox();
    const sessions = [conversationSession({
      id: "thread-active",
      name: "当前会话",
      model: "gpt-test",
    })];
    const archived = [conversationSession({
      id: "thread-archived",
      name: "旧会话",
      model: "gpt-test",
    })];
    const adapter = new FeishuConversationAdapter(
      {
        listSessions: vi.fn(async (
          _target: typeof message.target,
          options?: { archived?: boolean },
        ) => options?.archived ? archived : sessions),
        status: vi.fn(() => conversationStatus({
          threadId: "thread-active",
          workspaceId: "workspace",
        })),
      },
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
    const listSessions = vi.fn(async () => [conversationSession({
      id: "thread-auth",
      name: "认证修复",
    })]);
    const adapter = new FeishuConversationAdapter(
      {
        listSessions,
        status: vi.fn(() => conversationStatus({
          threadId: "thread-current",
          workspaceId: "workspace",
        })),
      },
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
      page: 1,
      searchTerm: "认证",
      turnCountMode: "cached",
    });
    await fixture.outbox.close();
  });

  it("keeps archived-session search inside cards", async () => {
    const fixture = createOutbox();
    const listSessions = vi.fn(async () => [conversationSession({
      id: "thread-archived",
      name: "历史认证修复",
    })]);
    const adapter = new FeishuConversationAdapter(
      { listSessions },
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
      page: 1,
      searchTerm: "认证",
      turnCountMode: "cached",
    });
    await fixture.outbox.close();
  });

  it("opens a complete Queue management card and keeps add as a command form", async () => {
    const fixture = createOutbox();
    const queueItems = Array.from({ length: 25 }, (_, index) => ({
      id: `01a02373-1bd5-7661-aa48-fc0ff087f${String(index).padStart(2, "0")}`,
      clientUserMessageId: `client-${index}`,
      inputType: "text" as const,
      textPreview: `安全预览 ${index + 1}`,
      editable: true,
    }));
    const queueList = vi.fn(async (_target: unknown, page = 1) => ({
      items: page === 1 ? queueItems : [],
      selectors: page === 1 ? queueItems.map((_, index) => String(index + 1)) : [],
      page,
      pageCount: 1,
      totalItemCount: queueItems.length,
    }));
    const queueAdd = vi.fn(async () => ({
      id: "queue-1",
      clientUserMessageId: "client-1",
      inputType: "text" as const,
      textPreview: "继续检查私聊失败路径",
      editable: true,
    }));
    const queueDelete = vi.fn(async () => ({ deleted: true }));
    const adapter = new FeishuConversationAdapter(
      { queueList, queueAdd, queueDelete },
      fixture.outbox,
      imagePort,
    );

    const firstChunk = await adapter.handleCommandCenterAction(
      message.target,
      "queue",
      message.actorId,
    );
    expect(firstChunk).toMatchObject({
      title: "App Server Queue · 第 1/1 页",
      choices: expect.arrayContaining([
        expect.objectContaining({
          action: "queue",
          input: expect.stringContaining("item 1 1 01a02373-1bd5-7661-aa48-fc0ff087f00"),
        }),
        expect.objectContaining({ label: "下一组" }),
      ]),
    });
    const firstChoices = (firstChunk as {
      choices: ReadonlyArray<{ input: string }>;
    }).choices;
    expect(firstChoices.length).toBeLessThanOrEqual(18);
    const secondChunk = await adapter.handleCommandCenterAction(
      message.target,
      "queue",
      message.actorId,
      "list 1 chunk 2",
    );
    expect(secondChunk).toMatchObject({
      choices: expect.arrayContaining([
        expect.objectContaining({
          input: `item 1 2 ${queueItems[13]!.id}`,
        }),
        expect.objectContaining({
          input: `item 1 2 ${queueItems[24]!.id}`,
        }),
      ]),
    });
    const secondChoices = (secondChunk as {
      choices: ReadonlyArray<{ input: string }>;
    }).choices;
    expect(secondChoices.length).toBeLessThanOrEqual(18);
    const queueItemInputs = [...firstChoices, ...secondChoices]
      .map(({ input }) => input)
      .filter((input) => input.startsWith("item "));
    expect(new Set(queueItemInputs)).toHaveLength(25);
    const itemChoices = await adapter.handleCommandCenterAction(
      message.target,
      "queue",
      message.actorId,
      `item 1 1 ${queueItems[0]!.id}`,
    );
    expect(itemChoices).toMatchObject({
      title: "Queue 条目",
      choices: expect.arrayContaining([
        { label: "启动", action: "queue", input: `start ${queueItems[0]!.id}` },
        { label: "删除", action: "queue", input: `delete-confirm 1 1 ${queueItems[0]!.id}` },
      ]),
    });
    const deleteChoices = await adapter.handleCommandCenterAction(
      message.target,
      "queue",
      message.actorId,
      `delete-confirm 1 1 ${queueItems[0]!.id}`,
    );
    expect(deleteChoices).toMatchObject({
      title: "确认删除 Queue 条目",
      choices: expect.arrayContaining([{
          label: "确认删除",
          action: "queue",
          input: `delete ${queueItems[0]!.id}`,
        }]),
    });
    await adapter.handleCommandCenterAction(
      message.target,
      "queue",
      message.actorId,
      `delete ${queueItems[0]!.id}`,
    );
    expect(queueDelete).toHaveBeenCalledWith(message.target, queueItems[0]!.id);
    await adapter.handleCommandCenterAction(
      message.target,
      "queue",
      message.actorId,
      "add 继续检查私聊失败路径",
    );
    await fixture.outbox.close();

    expect(queueAdd).toHaveBeenCalledWith(
      message.target,
      "继续检查私聊失败路径",
    );
    expect(fixture.sent.some(({ text }) => text.includes("已写入 App Server Queue"))).toBe(true);
  });

  it("manages Gateway scheduled tasks through shared commands and confirmation buttons", async () => {
    const fixture = createOutbox();
    const task = {
      taskId: "task-1",
      name: "每日检查",
      status: "active" as const,
      schedule: { type: "daily" as const, time: "09:00" },
      timezone: "Asia/Shanghai",
      nextRunAt: 1_785_000_000_000,
      workspaceId: "main",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: null,
      sandbox: "workspace-write" as const,
      permissions: null,
      promptPreview: "检查项目状态",
    };
    const scheduledTasks = {
      list: vi.fn(() => ({
        tasks: [task],
        selectors: ["1"],
        page: 1,
        pageCount: 1,
        totalTaskCount: 1,
      })),
      runs: vi.fn(() => ({
        task,
        runs: [],
        page: 1,
        pageCount: 1,
        totalRunCount: 0,
      })),
      previewCreate: vi.fn(() => ({
        action: "create" as const,
        token: "12345678-1234-1234-1234-123456789abc",
        expiresAt: Date.now() + 60_000,
        task,
      })),
    };
    const adapter = new FeishuConversationAdapter(
      {},
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { scheduledTasks: scheduledTasks as never },
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "schedule",
      message.actorId,
    )).resolves.toMatchObject({
      title: "Gateway 计划任务 · 第 1/1 页",
      choices: expect.arrayContaining([
        expect.objectContaining({ label: "已启用 · 每日检查", input: "task task-1" }),
        expect.objectContaining({ input: "add" }),
      ]),
    });
    await expect(adapter.handleCommandCenterAction(
      message.target,
      "schedule",
      message.actorId,
      "task task-1",
    )).resolves.toMatchObject({
      title: "每日检查",
      choices: expect.arrayContaining([
        expect.objectContaining({ input: "run task-1" }),
        expect.objectContaining({ input: "delete task-1" }),
      ]),
    });
    await expect(adapter.handleCommandCenterAction(
      message.target,
      "schedule",
      message.actorId,
      "add-daily",
    )).resolves.toMatchObject({
      kind: "form",
      inputPrefix: "add daily ",
    });
    await expect(adapter.handleCommandCenterAction(
      message.target,
      "schedule",
      message.actorId,
      "add daily 09:00 Asia/Shanghai 检查项目状态",
    )).resolves.toMatchObject({
      title: "确认创建计划任务",
      description: expect.stringContaining("计划：每天 09:00 · Asia/Shanghai"),
      choices: expect.arrayContaining([
        expect.objectContaining({
          input: "confirm 12345678-1234-1234-1234-123456789abc",
          acceptedState: expect.objectContaining({
            title: "已确认创建计划任务",
            template: "green",
          }),
        }),
        expect.objectContaining({
          label: "取消",
          acceptedState: expect.objectContaining({
            title: "已取消创建计划任务",
            template: "grey",
          }),
        }),
      ]),
    });
    const confirmation = await adapter.handleCommandCenterAction(
      message.target,
      "schedule",
      message.actorId,
      "add daily 09:00 Asia/Shanghai 检查项目状态",
    );
    expect(confirmation).toMatchObject({
      description: expect.stringContaining("无人值守执行"),
    });
    await fixture.outbox.close();
  });

  it("maps review cards back to the shared review command grammar", async () => {
    const fixture = createOutbox();
    const review = vi.fn(async () => ({
      threadId: "review-thread",
      turnId: "review-turn",
      steered: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { review },
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
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    }));
    const adapter = new FeishuConversationAdapter(
      { setGoal },
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "goal",
      message.actorId,
    )).resolves.toMatchObject({
      title: "Session Goal",
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
      {},
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
      {},
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
      {},
      fixture.outbox,
      imagePort,
    );

    await adapter.handle({ ...message, text: "/fs status" });
    await fixture.outbox.close();

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]?.chatId).toBe("oc_chat");
    expect(fixture.sent[0]?.text).toContain("长连接：未就绪");
  });

  it("submits unsupported slash-prefixed text as model input", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async (target: unknown, text: string) => {
      void [target, text];
      return {
        threadId: "thread-1",
        turnId: "turn-1",
        steered: false,
      };
    });
    const adapter = new FeishuConversationAdapter(
      { submit },
      fixture.outbox,
      imagePort,
    );

    const texts = [
      "/unknown",
      "/unknown-command",
      "/feishu status",
      "/STATUS",
      "/",
      "/测试",
    ];
    for (const [index, text] of texts.entries()) {
      await expect(adapter.handle({
        ...message,
        messageId: `om_message_${index}`,
        text,
      })).resolves.toBeUndefined();
    }
    await fixture.outbox.close();

    expect(submit.mock.calls.map((call) => call[1])).toEqual(texts);
    expect(fixture.sent).toEqual([]);
  });

  it("routes an authorized status command through Application instead of starting a Turn", async () => {
    const fixture = createOutbox();
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const status = vi.fn(() => conversationStatus({
      threadId: "thread-1",
      turnId: "turn-1",
      model: "gpt-test",
      effort: "medium",
      serviceTier: "priority",
    }));
    const adapter = new FeishuConversationAdapter(
      { submit, status },
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
        "## Codex 状态",
        "- Workspace：Main (main)",
        "- Session：未命名",
        "- Session ID：thread-1",
        "- Turn：turn-1",
        "- 工作目录：/workspace",
        "- Git 分支：未检测到",
        "- 模型：gpt-test",
        "- 提供商：OpenAI 官方",
        "- 思考等级：medium",
        "- Fast 模式：开启",
        "- 协作模式：Default",
        "",
        "- 当前 Session 用量：等待 App Server 推送统计",
      ].join("\n"),
    }]);
  });

  it("forwards command arguments through the shared Application command service", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const queueAdd = vi.fn(async () => ({
      id: "queue-2",
      clientUserMessageId: "client-2",
      inputType: "text" as const,
      textPreview: "继续检查参数",
      editable: true,
    }));
    const adapter = new FeishuConversationAdapter(
      { submit, queueAdd },
      fixture.outbox,
      imagePort,
    );

    await adapter.handle({ ...message, text: "/queue add 继续检查参数" });
    await fixture.outbox.close();

    expect(submit).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      message.target,
      "继续检查参数",
    );
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: expect.stringContaining("已写入 App Server Queue"),
    }]);
  });

  it("reports output queue rejection after a state-changing command without retrying it", async () => {
    const newSession = vi.fn(async () => ({}));
    const notifyText = vi.fn(() => false);
    const adapter = new FeishuConversationAdapter(
      { newSession },
      { notifyText } as unknown as FeishuOutbox,
      imagePort,
    );

    await expect(
      adapter.handle({ ...message, text: "/new" }),
    ).rejects.toMatchObject({ name: "FeishuOutputQueueError" });

    expect(newSession).toHaveBeenCalledTimes(1);
    expect(notifyText).toHaveBeenCalledTimes(1);
  });
});

function scheduledTaskPreview(): ScheduledTaskConfirmation {
  return {
    action: "create",
    token: "12345678-1234-1234-1234-123456789abc",
    expiresAt: 2,
    task: {
      taskId: "task-preview",
      name: "检查 CI",
      status: "active",
      schedule: { type: "interval", intervalMinutes: 60, anchorAt: 1 },
      timezone: "Asia/Shanghai",
      nextRunAt: 2,
      workspaceId: "main",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      sandbox: "workspace-write",
      permissions: null,
      promptPreview: "检查 CI",
    },
  };
}
