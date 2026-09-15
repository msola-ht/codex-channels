import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { vi } from "vitest";

import type {
  ConversationTurnUseCases,
  ScheduledTaskConfirmation,
  ScheduledTaskUseCases,
} from "../src/application/index.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { EventBus } from "../src/event-bus/event-bus.js";
import { TelegramAccessPolicy } from "../src/policy/telegram-access.js";
import {
  TelegramSurface,
  type TelegramAudioPort,
  type TelegramConversationUseCases,
  type TelegramImagePort,
} from "../src/surfaces/telegram/bot.js";
import type { TelegramTextFilePort } from "../src/surfaces/telegram/file-input.js";
import {
  conversationCommandExecutor,
  type ConversationMethodOverrides,
} from "./conversation-command-fixture.js";

export function cleanupTelegramSurfaceTestDirectories(directories: string[]) {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function scheduledTaskPreview(): ScheduledTaskConfirmation {
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

export function createTelegramSurfaceFixture(
  directories: string[],
  submit: ConversationTurnUseCases["submit"],
  download: ReturnType<typeof vi.fn>,
  serviceOverrides: Omit<ConversationMethodOverrides, "submit"> = {},
  downloadTextFile: ReturnType<typeof vi.fn> = vi.fn(),
  downloadAudio: ReturnType<typeof vi.fn> = vi.fn(),
  now?: () => number,
  debugEnabled = false,
  scheduledTasks?: ScheduledTaskUseCases,
): {
  surface: TelegramSurface;
  output: EventBus<OutputEvent>;
  apiCalls: string[];
  sentTexts: string[];
  apiPayloads: Array<{ method: string; payload: Record<string, unknown> }>;
  rememberActor: ReturnType<typeof vi.fn>;
} {
  const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
  const apiCalls: string[] = [];
  const sentTexts: string[] = [];
  const apiPayloads: Array<{
    method: string;
    payload: Record<string, unknown>;
  }> = [];
  const imageStore: TelegramImagePort = {
    start: async () => undefined,
    close: () => undefined,
    download: download as unknown as TelegramImagePort["download"],
  };
  const audioStore: TelegramAudioPort = {
    start: async () => undefined,
    close: () => undefined,
    download: downloadAudio as unknown as TelegramAudioPort["download"],
  };
  const directory = mkdtempSync(join(tmpdir(), "codex-telegram-surface-"));
  const rememberActor = vi.fn();
  directories.push(directory);
  const surfaceOptions = {
    gatewayVersion: "0.146.0",
    commands: conversationCommandExecutor({ submit, ...serviceOverrides }, scheduledTasks),
    inputQuietWindowMs: 0,
    imageStore,
    audioStore,
    textFileInput: {
      download: downloadTextFile as unknown as TelegramTextFilePort["download"],
    },
    actorRegistry: {
      actors: () => [],
      rememberActor,
    },
    ...(now === undefined ? {} : { now }),
    debugEnabled,
  };
  const conversations = telegramConversationUseCases({
    submit,
    ...serviceOverrides,
  });
  const surface = new TelegramSurface(
    "123:token",
    undefined,
    conversations,
    new TelegramAccessPolicy(new Set([123]), "default"),
    new Set(),
    [{ id: "main", name: "Main", cwd: "/workspace" }],
    directory,
    pino({ level: "silent" }),
    surfaceOptions,
  );
  output.subscribe("telegram-test-output", (event) => {
    surface.output.handle(event);
  });
  surface.bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Test Bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  surface.bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push(method);
    apiPayloads.push({
      method,
      payload: payload as Record<string, unknown>,
    });
    if (method === "sendMessage") {
      const text = (payload as { text?: unknown }).text;
      if (typeof text === "string") {
        sentTexts.push(text);
      }
      return {
        ok: true,
        result: {
          message_id: 99,
          date: 1,
          chat: telegramChat(),
          text: "ok",
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  return {
    surface,
    output,
    apiCalls,
    sentTexts,
    apiPayloads,
    rememberActor,
  };
}

function missingTelegramCapability(): never {
  throw new Error("测试未实现 Telegram 会话能力");
}

function telegramConversationUseCases(
  overrides: ConversationMethodOverrides,
): TelegramConversationUseCases {
  return new Proxy(overrides, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      if (property === "touchActivity") return undefined;
      return missingTelegramCapability;
    },
  }) as TelegramConversationUseCases;
}

export function telegramUser() {
  return { id: 123, is_bot: false, first_name: "User" };
}

export function telegramChat() {
  return { id: 100, type: "private" as const, first_name: "User" };
}

export function telegramPlugin(id: string, name: string, displayName: string) {
  return {
    id,
    name,
    displayName,
    marketplaceName: "local",
    description: null,
    enabled: true,
    available: true,
    version: null,
    localVersion: null,
    source: "local" as const,
    installedAt: null,
    developerName: null,
    category: null,
    capabilities: [],
    authPolicy: "onUse" as const,
    eligiblePlanTypes: [],
    disabledReason: null,
  };
}
