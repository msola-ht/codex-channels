import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  conversationCommandNames,
  type ConversationUseCases,
  type ScheduledTaskConfirmation,
} from "../src/application/index.js";
import { UserFacingError } from "../src/conversation-core/index.js";
import { ThreadSectionAccessPolicy } from "../src/policy/index.js";
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

const imageFixtureDirectory = mkdtempSync(join(tmpdir(), "codex-feishu-images-"));
const pngImagePath = join(imageFixtureDirectory, "image.png");
const jpegImagePath = join(imageFixtureDirectory, "image.jpg");
writeFileSync(pngImagePath, Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]), { mode: 0o600 });
writeFileSync(jpegImagePath, Buffer.from([0xff, 0xd8, 0xff]), { mode: 0o600 });
const pngDataUrl = "data:image/png;base64,iVBORw0KGgo=";
const jpegDataUrl = "data:image/jpeg;base64,/9j/";

afterAll(() => {
  rmSync(imageFixtureDirectory, { recursive: true, force: true });
});

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
    expect(fixture.sent[0]?.text).toBe("## 已请求停止当前任务。");
  });

  it("opens the composed command center for start and help", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const open = vi.fn(async () => {});
    const openResponse = vi.fn(async () => {});
    const adapter = new FeishuConversationAdapter(
      { submit } as unknown as ConversationUseCases,
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
      {} as ConversationUseCases,
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
      {} as ConversationUseCases,
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
    const modelState = vi.fn(async () => ({
      models: [
        {
          id: "gpt-test",
          model: "gpt-test",
          provider: "openai",
          displayName: "GPT Test",
          supportedReasoningEfforts: [{ effort: "medium", description: "平衡" }],
          defaultReasoningEffort: "medium",
          serviceTiers: [{ id: "priority", name: "Fast" }],
          defaultServiceTier: "priority",
          isDefault: true,
          inputModalities: ["text"],
        },
        {
          id: "deepseek-v4",
          model: "deepseek-v4",
          provider: "deepseek",
          displayName: "DeepSeek V4",
          supportedReasoningEfforts: [{ effort: "high", description: "深入" }],
          defaultReasoningEffort: "high",
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
          inputModalities: ["text"],
        },
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
      { modelState, clearModelBrowse } as unknown as ConversationUseCases,
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
    const selectModel = vi.fn(async () => ({
      models: [{
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
        inputModalities: ["text"],
      }],
      model: "gpt-test",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: null,
      pending: true,
      modelPending: true,
      effortPending: true,
      serviceTierPending: false,
    }));
    const adapter = new FeishuConversationAdapter(
      { selectModel } as unknown as ConversationUseCases,
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
    const modelState = vi.fn(async () => ({
      models: [{
        id: "deepseek-v4",
        model: "deepseek-v4",
        provider: "deepseek",
        displayName: "DeepSeek · DeepSeek V4",
        supportedReasoningEfforts: [{ effort: "high", description: "深入" }],
        defaultReasoningEffort: "high",
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
        inputModalities: ["text" as const],
      }],
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
      { modelState, selectModel, browseProviderModels } as unknown as ConversationUseCases,
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
        status: vi.fn(() => ({
          workspaceId: "main",
          workspaceName: "Main",
          cwd: "/workspace",
          threadId: "thread-1",
          turnId: null,
          model: "gpt-test",
          modelProvider: "openai",
          effort: "medium",
          serviceTier: null,
          modelPending: false,
          effortPending: false,
          fastModePending: false,
          collaborationMode: "default",
          collaborationModePending: false,
          gitBranch: null,
        })),
      } as unknown as ConversationUseCases,
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
    expect(fixture.sent).toHaveLength(1);
  });

  it("turns workspace permission updates into clickable card choices", async () => {
    const fixture = createOutbox();
    const updateWorkspacePermissions = vi.fn(async () => ({
      id: "codex-connect",
      name: "Workspace",
      cwd: "/workspace",
      approvalPolicy: "never",
    }));
    const adapter = new FeishuConversationAdapter(
      {
        status: () => ({ workspaceId: "codex-connect" }),
        listWorkspaces: () => [{
          id: "codex-connect",
          name: "Workspace",
          cwd: "/workspace",
          sandbox: "read-only",
        }],
        updateWorkspacePermissions,
      } as unknown as ConversationUseCases,
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
        status: () => ({ workspaceId: "codex-connect" }),
        listPermissionProfiles: async () => [{
          id: ":workspace",
          description: "允许工作区写入",
          allowed: true,
        }],
      } as unknown as ConversationUseCases,
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

  it("uses /pin for Pinned and only exposes custom Thread Section moves to administrators", async () => {
    const fixture = createOutbox();
    const pinned = {
      id: "section-pinned",
      name: "Pinned",
      builtIn: "pinned" as const,
      currentWorkspaceActiveCount: 0,
      currentWorkspaceArchivedCount: 0,
    };
    const custom = {
      id: "section-project",
      name: "项目",
      builtIn: null,
      currentWorkspaceActiveCount: 1,
      currentWorkspaceArchivedCount: 0,
    };
    const adapter = new FeishuConversationAdapter(
      {
        listThreadSections: vi.fn(async () => [pinned, custom]),
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "section",
      message.actorId,
    )).resolves.toMatchObject({
      title: "查看分区或固定当前会话 · 第 1/1 页",
      description: expect.stringContaining(
        "2. 项目 · 当前 Workspace：活动 1 / 归档 0",
      ),
      choices: [{
        label: "Pinned · 固定",
        action: "pin",
        input: "",
      }],
    });

    const administrator = new FeishuConversationAdapter(
      {
        listThreadSections: vi.fn(async () => [pinned, custom]),
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        threadSectionAccess: new ThreadSectionAccessPolicy(
          new Set(["feishu:ou_actor"]),
        ),
      },
    );
    await expect(administrator.handleCommandCenterAction(
      message.target,
      "section",
      message.actorId,
    )).resolves.toMatchObject({
      choices: [{
        label: "Pinned · 固定",
        action: "pin",
        input: "",
      }, {
        label: "项目",
        action: "section",
        input: "move section-project",
      }],
    });
    await fixture.outbox.close();
  });

  it("keeps Thread Section pagination inside the Feishu choice card", async () => {
    const fixture = createOutbox();
    const sections = Array.from({ length: 9 }, (_, index) => ({
      id: `section-${index + 1}`,
      name: index === 0 ? "Pinned" : `分区 ${index + 1}`,
      builtIn: index === 0 ? "pinned" as const : null,
      currentWorkspaceActiveCount: 0,
      currentWorkspaceArchivedCount: 0,
    }));
    const adapter = new FeishuConversationAdapter(
      {
        listThreadSections: vi.fn(async () => sections),
      } as unknown as ConversationUseCases,
      fixture.outbox,
      imagePort,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        threadSectionAccess: new ThreadSectionAccessPolicy(
          new Set(["feishu:ou_actor"]),
        ),
      },
    );

    await expect(adapter.handleCommandCenterAction(
      message.target,
      "section",
      message.actorId,
      "list 2",
    )).resolves.toMatchObject({
      title: "固定或移动当前会话 · 第 2/2 页",
      choices: [{
        label: "分区 9",
        action: "section",
        input: "move section-9",
      }, {
        label: "上一页",
        action: "section",
        input: "list 1",
      }],
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
      page: 1,
      searchTerm: "认证",
      turnCountMode: "cached",
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
      { queueList, queueAdd, queueDelete } as unknown as ConversationUseCases,
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
      {} as ConversationUseCases,
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
      { submit } as unknown as ConversationUseCases,
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
      { submit, queueAdd } as unknown as ConversationUseCases,
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

  it("rejects copied Feishu message links before reading replies or starting a Turn", async () => {
    const fixture = createOutbox();
    const submit = vi.fn();
    const readQuotedText = vi.fn();
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
      text: [
        "看看这条消息：",
        "https://applink.feishu.cn/client/message/link/open?token=sensitive-token",
      ].join("\n"),
    });
    await fixture.outbox.close();

    expect(readQuotedText).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: [
        "暂不支持通过飞书复制的消息链接读取内容。",
        "请直接回复目标消息，再发送你的要求。",
      ].join("\n"),
    }]);
    expect(fixture.sent[0]?.text).not.toContain("sensitive-token");
  });

  it("does not reject other Feishu AppLinks or lookalike hosts", async () => {
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
    const inputs = [
      "https://applink.feishu.cn/client/web_url/open?url=https%3A%2F%2Fexample.com",
      "https://applink.feishu.cn.example.com/client/message/link/open?token=value",
      "https://applink.feishu.cn/client/message/link/open",
    ];

    for (const text of inputs) {
      await adapter.handle({ ...message, text });
    }
    await fixture.outbox.close();

    expect(submit).toHaveBeenCalledTimes(inputs.length);
    for (const text of inputs) {
      expect(submit).toHaveBeenCalledWith(message.target, text);
    }
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
      path: pngImagePath,
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
      images: [{ url: pngDataUrl }],
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
      path: pngImagePath,
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
      images: [{ url: pngDataUrl }],
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
        path: pngImagePath,
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockResolvedValueOnce({
        path: jpegImagePath,
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
      images: [
        { url: pngDataUrl },
        { url: jpegDataUrl },
      ],
    });
    expect(fixture.sent).toEqual([]);
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
      path: pngImagePath,
        mimeType: "image/png" as const,
        bytes: 8,
      })
      .mockResolvedValueOnce({
        path: jpegImagePath,
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
      images: [
        { url: pngDataUrl },
        { url: jpegDataUrl },
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
          path: jpegImagePath,
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
    const replyToTurn = vi.fn(() => true);
    const adapter = new FeishuConversationAdapter(
      {
        submit: async () => ({
          threadId: "thread-1",
          turnId: "turn-1",
          steered: true,
        }),
      } as unknown as ConversationUseCases,
      {
        notifyMarkdown: vi.fn(() => true),
        notifyText: vi.fn(() => true),
        replyToTurn,
      } as unknown as FeishuOutbox,
      imagePort,
    );

    await adapter.handle(message);

    expect(replyToTurn).toHaveBeenCalledWith(
      "oc_chat",
      "thread-1",
      "turn-1",
      "已将补充要求追加到当前 Turn：\n\n> 继续开发",
    );
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
      text: "操作失败：该 Codex Session 已绑定到其他会话。",
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
