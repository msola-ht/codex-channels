import { describe, expect, it } from "vitest";
import type { ProviderAccountUsage } from "../src/application/index.js";
import { completionAccountStatus } from "../src/bootstrap/completion-account-status.js";
import { createTurnCompletedPresentation, renderPlainLifecyclePresentation } from "../src/surfaces/lifecycle-presentation.js";
import { formatResetTime } from "../src/surfaces/account-format.js";

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
  it.each(["ocg-main", "clp-main"])("shows remaining windows for %s", (provider) => {
    const result = render(provider, { provider, kind: "quota-windows", available: true, windows: [window,
      { ...window, windowId: "five-hour", label: "5小时", usedPercent: 100, resetsAt: null }] });
    expect(result).toContain("账户状态");
    expect(result).toContain(`周限：剩余 91% · 重置 ${formatResetTime(window.resetsAt)}`);
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
