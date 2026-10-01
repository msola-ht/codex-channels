import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { ConversationCommandService, ConversationResetCreditService, OpenAiResetCreditService, type ConversationCommandResult, type OpenAiResetCreditSnapshot } from "../src/application/index.js";
import { UserFacingError, type ConversationTarget } from "../src/conversation-core/index.js";
import { renderFeishuCommandResult } from "../src/surfaces/feishu/renderer.js";
import { renderWeixinCommandResult } from "../src/surfaces/weixin/command-renderer.js";
import { renderTelegramCommandResult, telegramResetCreditListToken } from "../src/surfaces/telegram/command-renderer.js";
import { formatSurfaceUserFacingError } from "../src/surfaces/user-facing-error-format.js";
import { conversationCommandUseCases } from "./conversation-command-fixture.js";
import { cleanupTelegramSurfaceTestDirectories, createTelegramSurfaceFixture, telegramChat, telegramUser } from "./telegram-surface-test-fixture.js";
import { createOutbox, FeishuConversationAdapter, imagePort, message } from "./feishu-adapter-test-fixture.js";
const directories: string[] = [];
afterEach(() => cleanupTelegramSurfaceTestDirectories(directories));
const target: ConversationTarget = { surface: "telegram", accountId: "default", conversationId: "room-a" };
function fixture() {
  const snapshot: OpenAiResetCreditSnapshot = { accountId: "openai-a", availableCount: "1", credits: [
    { id: "credit-a", title: "Official reset", description: "Official scope", expiresAt: null },
  ] };
  const read = vi.fn(async () => structuredClone(snapshot));
  const consume = vi.fn(async () => "reset" as const);
  const refresh = vi.fn(async () => {});
  const state = { context: "workspace-a/thread-a", allowed: true };
  const authorize = vi.fn(() => {
    if (!state.allowed) throw new UserFacingError("reset-credit.failed", "Forbidden", { reason: "forbidden" });
    return state.context;
  });
  const shared = new OpenAiResetCreditService({ readResetCredits: read, consumeResetCredit: consume }, refresh);
  const channels = new ConversationResetCreditService(shared, authorize);
  const commands = new ConversationCommandService(conversationCommandUseCases({}), undefined, channels);
  return { snapshot, read, consume, state, shared, channels, commands };
}
async function preview(f: ReturnType<typeof fixture>) {
  const result = await f.channels.execute(target, "actor-a", "reset use credit-a");
  if (result.type !== "preview") throw new Error("Expected preview");
  return result;
}
describe("channel reset credit authorization", () => {
  it.each(["telegram", "feishu", "weixin"] as const)("routes %s list and preview without consuming", async surface => {
    const f = fixture();
    expect(await f.commands.execute({ ...target, surface }, "limits", "reset", "actor-a")).toMatchObject({ kind: "reset-credit", result: { type: "list", credits: f.snapshot.credits } });
    expect(await f.commands.execute({ ...target, surface }, "limits", "reset use credit-a", "actor-a")).toMatchObject({ kind: "reset-credit", result: { type: "preview", accountId: "openai-a" } });
    expect(f.consume).not.toHaveBeenCalled();
  });
  it("requires an identified authorized actor before querying", async () => {
    const f = fixture();
    await expect(f.channels.execute(target, undefined, "reset")).rejects.toMatchObject({ details: { reason: "forbidden" } });
    f.state.allowed = false;
    await expect(f.channels.execute(target, "actor-a", "reset")).rejects.toMatchObject({ details: { reason: "forbidden" } });
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["actor", "conversation", "surface", "account"])("does not let another %s consume or invalidate the owner's token", async field => {
    const f = fixture(); const p = await preview(f);
    const other = { ...target, ...(field === "conversation" ? { conversationId: "other" } : field === "surface" ? { surface: "feishu" as const } : field === "account" ? { accountId: "other" } : {}) };
    await expect(f.channels.execute(other, field === "actor" ? "actor-b" : "actor-a", `reset confirm ${p.token}`)).rejects.toMatchObject({ details: { reason: "reset_stale" } });
    expect(f.consume).not.toHaveBeenCalled();
    await expect(f.channels.execute(target, "actor-a", `reset confirm ${p.token}`)).resolves.toMatchObject({ type: "consumed", outcome: "reset" });
    await expect(f.channels.execute(target, "actor-a", `reset confirm ${p.token}`)).rejects.toMatchObject({ details: { reason: "reset_stale" } });
    expect(f.consume).toHaveBeenCalledOnce();
  });
  it.each(["before", "during"])("rejects changed workspace/thread %s final account read", async when => {
    const f = fixture(); const p = await preview(f);
    if (when === "before") f.state.context = "workspace-b/thread-b";
    else f.read.mockImplementationOnce(async () => { f.state.context = "workspace-b/thread-b"; return f.snapshot; });
    await expect(f.channels.execute(target, "actor-a", `reset confirm ${p.token}`)).rejects.toMatchObject({ details: { reason: "reset_stale" } });
    expect(f.consume).not.toHaveBeenCalled();
  });
  it("rechecks revocation immediately before consumption", async () => {
    const f = fixture(); const p = await preview(f);
    f.read.mockImplementationOnce(async () => { f.state.allowed = false; return f.snapshot; });
    await expect(f.channels.execute(target, "actor-a", `reset confirm ${p.token}`)).rejects.toMatchObject({ details: { reason: "forbidden" } });
    expect(f.consume).not.toHaveBeenCalled();
  });
  it("cancels the shared attempt and rejects expired confirmations", async () => {
    const f = fixture(); const p = await preview(f);
    expect(await f.channels.execute(target, "actor-a", `reset cancel ${p.token}`)).toEqual({ type: "cancelled" });
    await expect(f.shared.consume(p.token)).rejects.toMatchObject({ code: "reset_stale" });
    const next = await preview(f);
    const clock = vi.spyOn(Date, "now").mockReturnValue(next.expiresAt);
    try { await expect(f.channels.execute(target, "actor-a", `reset confirm ${next.token}`)).rejects.toMatchObject({ details: { reason: "reset_stale" } }); }
    finally { clock.mockRestore(); }
    expect(f.consume).not.toHaveBeenCalled();
  });
  it("releases both confirmation layers when another consume is in flight", async () => {
    const f = fixture(); const a = await preview(f); const b = await preview(f);
    let finish!: (value: "reset") => void;
    f.consume.mockImplementationOnce(() => new Promise<"reset">(resolve => { finish = resolve; }));
    const inFlight = f.channels.execute(target, "actor-a", `reset confirm ${a.token}`);
    await vi.waitFor(() => expect(f.consume).toHaveBeenCalledOnce());
    await expect(f.channels.execute(target, "actor-a", `reset confirm ${b.token}`)).rejects.toMatchObject({ details: { reason: "reset_busy" } });
    finish("reset"); await inFlight;
    await expect(f.channels.execute(target, "actor-a", `reset cancel ${b.token}`)).rejects.toMatchObject({ details: { reason: "reset_stale" } });
    await expect(f.shared.consume(b.token)).rejects.toMatchObject({ code: "reset_stale" });
    expect(f.consume).toHaveBeenCalledOnce();
  });
  it("returns a controlled unknown result without retrying writes", async () => {
    const f = fixture(); const p = await preview(f); f.consume.mockRejectedValue(new Error("sensitive upstream response"));
    await expect(f.channels.execute(target, "actor-a", `reset confirm ${p.token}`)).rejects.toMatchObject({ code: "reset-credit.failed", details: { reason: "reset_unknown" } });
    expect(f.consume).toHaveBeenCalledOnce();
  });
  it("paginates details and rejects unknown syntax", async () => {
    const f = fixture(); f.snapshot.credits = Array.from({ length: 9 }, (_, i) => ({ ...f.snapshot.credits[0]!, id: `credit-${i}` }));
    expect(await f.channels.execute(target, "actor-a", "reset 2")).toMatchObject({ type: "list", page: 2, pageCount: 2, credits: [{ id: "credit-8" }] });
    for (const input of ["reset 3", "reset use", "reset confirm", "reset yes credit-a", "unknown"]) {
      await expect(f.channels.execute(target, "actor-a", input)).rejects.toMatchObject({ details: { reason: "usage" } });
    }
  });
  it("renders actionable preview and controlled errors for all three channels", async () => {
    const f = fixture(); const p = await preview(f);
    const result: ConversationCommandResult = { kind: "reset-credit", result: p };
    for (const render of [renderFeishuCommandResult, renderWeixinCommandResult]) {
      expect(render(result)).toContain(`/limits reset confirm ${p.token}`);
      expect(render(result)).toContain(`/limits reset cancel ${p.token}`);
      expect(render(result)).toContain("Official scope");
    }
    const reply = vi.fn(async () => ({}));
    await renderTelegramCommandResult({ reply } as unknown as Context, result);
    expect(reply.mock.calls.flat().join(" ")).toContain("请点击下方按钮");
    for (const label of ["Telegram", "飞书", "微信"] as const) {
      const text = formatSurfaceUserFacingError(new UserFacingError("reset-credit.failed", "private", { reason: "reset_unknown" }), label);
      expect(text).toContain("结果待确认"); expect(text).not.toContain("private");
    }
  });
});


describe("native reset credit buttons", () => {
  it("provides the reset-credit entry on OpenAI limits in both button channels", async () => {
    const result: Extract<ConversationCommandResult, { kind: "limits" }> = { kind: "limits", result: {
      kind: "rate-limits", provider: "openai", limits: {
        limits: [], ordinaryUsageLimit: { limitId: "codex", limitName: null, normalModelSlug: null,
          primary: null, secondary: null, credits: null, individualLimit: null, spendControlReached: null,
          planType: null, rateLimitReachedType: null },
        resetCreditsAvailable: 1, accountId: "openai-a", ordinaryUsageAllowed: null,
        lunaReserve: null, unsupportedUpsellPresent: false,
      },
    } };
    const reply = vi.fn(async () => ({}));
    await renderTelegramCommandResult({ reply } as unknown as Context, result);
    expect(reply).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reply_markup: {
      inline_keyboard: [[{ text: "查看重置券", callback_data: "rc:page:1" }]],
    } }));
    const outbox = createOutbox();
    try {
      const adapter = new FeishuConversationAdapter({ providerAccountLimits: async () => result.result }, outbox.outbox, imagePort);
      expect(await adapter.handleCommandCenterAction(message.target, "limits", message.actorId, "")).toMatchObject({
        choices: [{ label: "查看重置券", action: "limits", input: "reset" }],
      });
    } finally { await outbox.outbox.close(); }
  });
  it.each(["confirm", "cancel"])("Telegram selects then %s once with native callbacks", async operation => {
    const f = fixture();
    const { surface, output, apiPayloads, sentTexts } = createTelegramSurfaceFixture(
      directories, vi.fn(), vi.fn(), {}, vi.fn(), vi.fn(), undefined, false, undefined, undefined, f.channels,
    );
    let updateId = 100;
    const click = (data: string) => surface.bot.handleUpdate({
      update_id: updateId++, callback_query: { id: String(updateId), from: telegramUser(), chat_instance: "test", data,
        message: { message_id: 30, date: 1, chat: telegramChat(), text: "重置券" } },
    });
    const buttons = () => {
      const sent = apiPayloads.filter(p => p.method === "sendMessage").at(-1)!;
      return (sent.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard.flat();
    };
    try {
      await click("rc:page:1");
      const select = buttons().find(b => b.callback_data.startsWith("rc:use:"))!;
      expect(Buffer.byteLength(select.callback_data)).toBeLessThanOrEqual(64);
      expect(select.callback_data).not.toContain("credit-a");
      await click(select.callback_data);
      expect(f.consume).not.toHaveBeenCalled();
      const confirmation = buttons();
      expect(confirmation.map(b => b.text)).toEqual(["确认使用", "取消"]);
      const chosen = confirmation.find(b => b.callback_data.startsWith(`rc:${operation}:`))!;
      await click(chosen.callback_data);
      expect(f.consume).toHaveBeenCalledTimes(operation === "confirm" ? 1 : 0);
      expect(apiPayloads.some(p => p.method === "editMessageReplyMarkup")).toBe(true);
      await click(confirmation[0]!.callback_data);
      expect(f.consume).toHaveBeenCalledTimes(operation === "confirm" ? 1 : 0);
      expect(sentTexts.join("\n")).toContain("请重新使用 /limits reset");
    } finally { await surface.stop(); await output.close(); }
  });
  it("Telegram refuses a changed list before creating a confirmation", async () => {
    const f = fixture();
    const list = await f.commands.execute(target, "limits", "reset", "actor-a");
    if (list.kind !== "reset-credit") throw new Error("Expected list");
    const token = telegramResetCreditListToken(list, "100", "123");
    expect(telegramResetCreditListToken(list, "other", "123")).not.toBe(token);
    expect(telegramResetCreditListToken(list, "100", "other")).not.toBe(token);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
    try { expect(telegramResetCreditListToken(list, "100", "123")).not.toBe(token); }
    finally { clock.mockRestore(); }
    f.snapshot.credits[0]!.id = "changed";
    const { surface, output, sentTexts } = createTelegramSurfaceFixture(
      directories, vi.fn(), vi.fn(), {}, vi.fn(), vi.fn(), undefined, false, undefined, undefined, f.channels,
    );
    try {
      await surface.bot.handleUpdate({ update_id: 1, callback_query: { id: "stale", from: telegramUser(), chat_instance: "test",
        data: `rc:use:1:0:${token}`, message: { message_id: 1, date: 1, chat: telegramChat(), text: "重置券" } } });
      expect(sentTexts.join("\n")).toContain("请重新使用 /limits reset");
      expect(f.consume).not.toHaveBeenCalled();
      expect(f.read).toHaveBeenCalledTimes(2);
    } finally { await surface.stop(); await output.close(); }
  });
  it.each(["confirm", "cancel"])("Feishu uses model-style choices for selection and %s", async operation => {
    const f = fixture(); const outbox = createOutbox();
    const openResponse = vi.fn(async () => {});
    const adapter = new FeishuConversationAdapter({}, outbox.outbox, imagePort, undefined, undefined,
      { openResponse } as unknown as NonNullable<ConstructorParameters<typeof FeishuConversationAdapter>[5]>,
      undefined, undefined, { resetCredits: f.channels });
    try {
      await adapter.handle({ ...message, text: "/limits reset" });
      expect(openResponse).toHaveBeenCalledWith(message.target, message.actorId, expect.objectContaining({ title: "选择重置券" }));
      const list = await adapter.handleCommandCenterAction(message.target, "limits", message.actorId, "reset");
      if (!list || !("choices" in list)) throw new Error("Expected choices");
      const preview = await adapter.handleCommandCenterAction(message.target, "limits", message.actorId, list.choices[0]!.input);
      if (!preview || !("choices" in preview)) throw new Error("Expected confirmation");
      expect(preview.choices.map(c => c.label)).toEqual(["确认使用", "取消"]);
      expect(f.consume).not.toHaveBeenCalled();
      const choice = preview.choices.find(c => c.input.startsWith(`reset ${operation} `))!;
      expect(choice.acceptedState?.title).toBe("重置券请求已提交");
      await adapter.handleCommandCenterAction(message.target, "limits", message.actorId, choice.input);
      expect(f.consume).toHaveBeenCalledTimes(operation === "confirm" ? 1 : 0);
    } finally { await outbox.outbox.close(); }
  });
});
