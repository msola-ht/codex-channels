import { describe, expect, it } from "vitest";
import type { ProviderAccountUsage } from "../src/application/index.js";
import { completionAccountStatus } from "../src/bootstrap/completion-account-status.js";
import { createTurnCompletedPresentation, renderPlainLifecyclePresentation } from "../src/surfaces/lifecycle-presentation.js";
import { formatResetTime } from "../src/surfaces/account-format.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { renderFeishuOutput } from "../src/surfaces/feishu/renderer.js";
import { renderTelegramLifecyclePresentation } from "../src/surfaces/telegram/format.js";
import { renderWeixinTurnCompleted } from "../src/surfaces/weixin/command-renderer.js";

const target = { surface: "feishu", accountId: "main", conversationId: "chat" };
const window = { windowId: "weekly", label: "周限", usedPercent: 9, resetsAt: 1_800_000_000, status: null };
function render(provider: string, usage: ProviderAccountUsage) {
  const accountStatus = completionAccountStatus(provider, usage);
  return renderPlainLifecyclePresentation(createTurnCompletedPresentation({
    type: "turn.completed", target, threadId: "thread", turnId: "turn", status: "completed",
    modelProvider: provider, ...(accountStatus === undefined ? {} : { accountStatus }),
  }));
}

describe("completion account status", () => {
  it.each([false, true])("keeps provider dates and timezone consistent across channels (debug=%s)", debug => {
    for (const provider of ["openai", "ocg-main", "clp-main", "ccg-main", "ds-main", "custom"]) {
      for (const resetsAt of [null, 0, window.resetsAt]) {
        const usage: ProviderAccountUsage = provider === "ds-main"
          ? { provider, kind: "balance", available: true, balances: [{ currency: "CNY", totalBalance: "0.00", grantedBalance: "0", toppedUpBalance: "0" }] }
          : provider === "ccg-main"
            ? { provider, kind: "credit-usage", available: true, planId: null, totalRemaining: "0", monthlyRemaining: "0", purchasedRemaining: "0", freeRemaining: "0", windows: [{ ...window, resetsAt }] }
            : provider === "custom"
              ? { provider, kind: "unsupported" }
              : { provider, kind: "quota-windows", available: true, windows: [{ ...window, resetsAt }] };
        const accountStatus = completionAccountStatus(provider, usage);
        const event: Extract<OutputEvent, { type: "turn.completed" }> = {
          type: "turn.completed", target, threadId: "thread", turnId: "turn", status: "completed", modelProvider: provider,
          ...(provider === "openai"
            ? { weeklyLimit: { usedPercent: 9, windowDurationMins: 10080, resetsAt } }
            : accountStatus === undefined ? {} : { accountStatus }),
        };
        const outputs = [renderFeishuOutput(event, debug),
          renderTelegramLifecyclePresentation(createTurnCompletedPresentation(event, debug)),
          renderWeixinTurnCompleted(event, debug)];
        const hasDate = resetsAt !== null && provider !== "ds-main" && provider !== "custom";
        for (const output of outputs) {
          expect(output?.includes("时区：")).toBe(hasDate);
          if (hasDate) {
            expect(output).toContain(`时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
            expect(output).toContain(`重置：${formatResetTime(resetsAt)}`);
          }
        }
        expect(new Set(outputs).size).toBe(1);
        const mismatched = { ...event, modelProvider: "other" };
        expect(renderPlainLifecyclePresentation(createTurnCompletedPresentation(mismatched, debug))).not.toContain("时区：");
      }
    }
  });
  it.each(["ocg-main", "clp-main"])("shows remaining windows for %s", (provider) => {
    const result = render(provider, { provider, kind: "quota-windows", available: true, windows: [window,
      { ...window, windowId: "five-hour", label: "5小时", usedPercent: 100, resetsAt: null }] });
    expect(result).toContain("账户状态");
    expect(result).toContain(`周限：剩余 91%\n  - 重置：${formatResetTime(window.resetsAt)}\n  - `);
    expect(result).toContain("5小时：剩余 0%");
    expect(result).not.toContain("重置 未知");
  });
  it("shows official credits without mixing currencies with percentages", () => {
    expect(render("ccg-main", { provider: "ccg-main", kind: "credit-usage", available: true, planId: null,
      totalRemaining: "12.50", monthlyRemaining: "10", purchasedRemaining: "2.50", freeRemaining: "0", windows: [window],
    })).toContain("剩余额度：$12.50");
  });
  it("keeps a zero official balance even when the account cannot make requests", () => {
    expect(render("ds-main", { provider: "ds-main", kind: "balance", available: false,
      balances: [{ currency: "CNY", totalBalance: "0.00", grantedBalance: "0", toppedUpBalance: "0" }],
    })).toContain("余额：¥0.00");
  });
  it("omits unsupported, empty and mismatched account data", () => {
    for (const usage of [
      { kind: "unsupported", provider: "custom" },
      { kind: "subscription-required", provider: "ocg-main" },
      { kind: "quota-windows", provider: "clp-main", available: true, windows: [] },
      { kind: "balance", provider: "ds-main", available: true, balances: [] },
    ] satisfies ProviderAccountUsage[]) expect(render(usage.provider, usage)).not.toContain("账户状态");
    expect(render("clp-other", { provider: "clp-main", kind: "quota-windows", available: true, windows: [window] })).not.toContain("账户状态");
    expect(render("openai", { provider: "openai", kind: "quota-windows", available: true, windows: [window] })).not.toContain("账户状态");
  });
});
