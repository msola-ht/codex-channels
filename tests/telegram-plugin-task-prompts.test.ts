import { describe, expect, it } from "vitest";

import { TelegramPluginTaskPrompts } from "../src/surfaces/telegram/plugin-task-prompts.js";

describe("TelegramPluginTaskPrompts", () => {
  it("binds a one-time Plugin task prompt to its chat, actor, and reply message", () => {
    const prompts = new TelegramPluginTaskPrompts({ now: () => 1_000 });
    prompts.add({
      chatId: "chat-1",
      actorId: "actor-1",
      messageId: 42,
      pluginId: "github@local",
      pluginName: "GitHub",
    });

    expect(prompts.consume("chat-1", "actor-2", 42)).toEqual({
      kind: "forbidden",
    });
    expect(prompts.consume("chat-1", "actor-1", 41)).toEqual({ kind: "none" });
    expect(prompts.consume("chat-1", "actor-1", 42)).toEqual({
      kind: "matched",
      pluginId: "github@local",
      pluginName: "GitHub",
    });
    expect(prompts.consume("chat-1", "actor-1", 42)).toEqual({ kind: "none" });
  });

  it("reports expired prompts instead of treating their replies as normal Turn input", () => {
    let now = 1_000;
    const prompts = new TelegramPluginTaskPrompts({
      now: () => now,
      lifetimeMs: 100,
    });
    prompts.add({
      chatId: "chat-1",
      actorId: "actor-1",
      messageId: 42,
      pluginId: "github@local",
      pluginName: "GitHub",
    });
    now = 1_101;
    prompts.add({
      chatId: "chat-1",
      actorId: "actor-1",
      messageId: 43,
      pluginId: "slack@local",
      pluginName: "Slack",
    });

    expect(prompts.consume("chat-1", "actor-1", 42)).toEqual({
      kind: "expired",
    });
  });

  it("evicts the oldest prompt when the bounded registry is full", () => {
    let now = 1_000;
    const prompts = new TelegramPluginTaskPrompts({
      now: () => now,
      capacity: 1,
    });
    prompts.add({
      chatId: "chat-1",
      actorId: "actor-1",
      messageId: 41,
      pluginId: "github@local",
      pluginName: "GitHub",
    });
    now += 1;
    prompts.add({
      chatId: "chat-1",
      actorId: "actor-1",
      messageId: 42,
      pluginId: "slack@local",
      pluginName: "Slack",
    });

    expect(prompts.consume("chat-1", "actor-1", 41)).toEqual({ kind: "none" });
    expect(prompts.consume("chat-1", "actor-1", 42)).toMatchObject({
      kind: "matched",
      pluginId: "slack@local",
    });
  });
});
