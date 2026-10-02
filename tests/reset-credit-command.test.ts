import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runResetCreditCommand } from "../scripts/reset-credit-command.mjs";
import { GatewayAccountRefreshError, GatewayAccountRefreshServer } from "../runtime/gateway-account-refresh.mjs";
import { OpenAiResetCreditService, ResetCreditError } from "../src/application/index.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function capture(isTTY = true) {
  let content = "";
  return { isTTY, write: (text: string) => { content += text; }, text: () => content };
}
const credit = { id: "credit-a", title: "Official reset", description: "Official scope", expiresAt: null as number | null };
const snapshot = { accountId: "account-a", availableCount: "1", credits: [credit] };
function fixture(confirmed: unknown = true) {
  const directory = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rc-")); directories.push(directory);
  const configPath = join(directory, "config.toml"); writeFileSync(configPath, "");
  const output = capture();
  const prompt = { select: vi.fn(async () => credit.id), confirm: vi.fn(async () => confirmed), isCancel: (v: unknown) => typeof v === "symbol" };
  const request = vi.fn(async (_path: string, operation: { method: string }) => operation.method === "reset/list" ? snapshot
    : operation.method === "reset/preview" ? { accountId: snapshot.accountId, attemptId: "attempt-a", credit }
      : { outcome: "reset", refreshed: true });
  return { environment: { CODEX_CONNECT_CONFIG_FILE: configPath }, output, input: { isTTY: true }, prompt, request };
}

describe("reset-credit CLI", () => {
  it.each([[], ["-h"], ["--help"], ["list", "-h"], ["list", "--help"], ["use", "-h"], ["use", "--help"]])("shows help before configuration or IPC: %j", async (...args) => {
    const f = fixture();
    await runResetCreditCommand(args, { ...f, environment: { CODEX_CONNECT_CONFIG_FILE: "/missing/config.toml" } });
    expect(f.output.text()).toContain("用法：codexc reset-credit");
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([["list", "--yes"], ["use", "--yes"], ["use", "a", "b"], ["consume"], ["list", "--json", "--json"]])("rejects unsupported arguments: %j", async (...args) => {
    const f = fixture();
    await expect(runResetCreditCommand(args, f)).rejects.toThrow("用法");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("exposes canonical help paths through the installed CLI entry before reading configuration", async () => {
    for (const command of [[], ["list"], ["use"]]) for (const flag of ["-h", "--help"]) {
      const { stdout } = await promisify(execFile)(process.execPath, ["bin/codexc.mjs", "reset-credit", ...command, flag], {
        cwd: process.cwd(), env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: "/missing/reset-credit-config.toml" },
      });
      expect(stdout).toContain("用法：codexc reset-credit");
    }
  });
  it.each(["nothingToReset", "noCredit", "alreadyRedeemed"])("preserves the official %s result when refresh fails", async outcome => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ accountId: "account-a", attemptId: "attempt-a", credit })
      .mockResolvedValueOnce({ outcome, refreshed: false });
    await expect(runResetCreditCommand(["use", "credit-a"], f)).resolves.toEqual({ outcome, refreshed: false });
    expect(f.output.text()).toContain("操作结果已确认");
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("cancels selection before creating a preview", async () => {
    const f = fixture();
    f.prompt.select.mockResolvedValueOnce(Symbol("cancel") as unknown as string);
    await runResetCreditCommand(["use"], f);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.prompt.confirm).not.toHaveBeenCalled();
  });
  it("rejects noninteractive consumption before requests", async () => {
    const f = fixture();
    await expect(runResetCreditCommand(["use", "credit-a"], { ...f, input: { isTTY: false } })).rejects.toThrow("交互终端");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("labels human-readable expiry as UTC without changing JSON timestamps", async () => {
    const f = fixture();
    const dated = { ...snapshot, credits: [{ ...credit, expiresAt: 1790993155 }] };
    f.request.mockResolvedValueOnce(dated).mockResolvedValueOnce(dated);
    await runResetCreditCommand(["list"], f);
    expect(f.output.text()).toContain("到期：2026-10-03T02:05:55.000Z（UTC）");
    const output = capture();
    await runResetCreditCommand(["list", "--json"], { ...f, output });
    expect(JSON.parse(output.text())).toEqual(dated);
  });
  it("lists JSON without prompting or consuming", async () => {
    const f = fixture();
    await runResetCreditCommand(["list", "--json"], { ...f, output: Object.assign(f.output, { isTTY: false }) });
    expect(JSON.parse(f.output.text())).toEqual(snapshot);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.prompt.confirm).not.toHaveBeenCalled();
  });
  it.each([false, Symbol("cancel"), "yes"])("consumes only a literal confirmed choice: %s", async value => {
    const f = fixture(value);
    await runResetCreditCommand(["use", "credit-a"], f);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.at(-1)?.[1]).toEqual({ method: "reset/cancel", attemptId: "attempt-a" });
    expect(f.output.text()).toContain("已取消");
  });
  it("selects, previews and explicitly confirms with default rejection", async () => {
    const f = fixture();
    await runResetCreditCommand(["use"], f);
    expect(f.request.mock.calls.map(call => call[1])).toEqual([
      { method: "reset/list" }, { method: "reset/preview", creditId: "credit-a" }, { method: "reset/consume", attemptId: "attempt-a" },
    ]);
    expect(f.prompt.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(f.output.text()).toContain("account-a");
    expect(f.output.text()).toContain("Official scope");
    expect(f.output.text()).toContain("用量已重置");
  });
  it("sanitizes terminal controls in official descriptions", async () => {
    const f = fixture(false);
    f.request.mockResolvedValueOnce({ ...snapshot, credits: [{ ...credit, title: "\x1b[31mred\x1b[0m", description: "\x1b]52;c;secret\x07\rtext" }] });
    await runResetCreditCommand(["list"], f);
    expect(f.output.text()).not.toContain("\x1b");
    expect(f.output.text()).not.toContain("\r");
  });
  it("does not retry or expose internal failures after a consume", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ accountId: "account-a", attemptId: "attempt-a", credit }).mockRejectedValueOnce(new Error("private upstream response"));
    await expect(runResetCreditCommand(["use", "credit-a"], f)).rejects.toThrow("结果待确认");
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.output.text()).not.toContain("private upstream");
  });
  it("releases a known preview with a fresh signal after interrupting the prompt", async () => {
    const f = fixture(false);
    f.prompt.confirm.mockImplementationOnce(async () => { process.emit("SIGINT"); return false; });
    const signals: AbortSignal[] = [];
    const request = async (path: string, operation: { method: string }, signal: AbortSignal) => {
      signals.push(signal); return f.request(path, operation);
    };
    await runResetCreditCommand(["use", "credit-a"], { ...f, request });
    expect(f.request.mock.calls.map(call => call[1].method)).toEqual(["reset/preview", "reset/cancel"]);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
  it("reports cleanup failure without retrying or losing the uncertain consume result", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ accountId: "account-a", attemptId: "attempt-a", credit })
      .mockRejectedValue(new Error("private connection details"));
    await expect(runResetCreditCommand(["use", "credit-a"], f)).rejects.toThrow("结果待确认");
    expect(f.request.mock.calls.map(call => call[1].method)).toEqual(["reset/preview", "reset/consume", "reset/cancel"]);
    expect(f.output.text()).toContain("清理未确认");
    expect(f.output.text()).not.toContain("private connection details");
  });
  it("uses Gateway IPC and shared account checks without a WebUI server", async () => {
    const directory = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rc-")); directories.push(directory);
    const configPath = join(directory, "config.toml"); writeFileSync(configPath, "");
    const current = structuredClone(snapshot);
    const consume = vi.fn(async () => "reset" as const);
    const service = new OpenAiResetCreditService({ readResetCredits: async () => structuredClone(current), consumeResetCredit: consume }, async () => {});
    const server = new GatewayAccountRefreshServer(configPath, async () => true, async (request, signal) => {
      try {
        if (request.method === "reset/cancel") { service.cancel(request.attemptId); return { cancelled: true }; }
        return request.method === "reset/list" ? await service.list(signal) : request.method === "reset/preview"
        ? await service.preview(request.creditId, signal) : await service.consume(request.attemptId, signal); }
      catch (error) { throw new GatewayAccountRefreshError(error instanceof ResetCreditError ? error.code : "reset_unavailable", "Operation failed"); }
    });
    await server.start();
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["bin/codexc.mjs", "reset-credit", "list", "--json"], {
        cwd: process.cwd(), env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      });
      expect(JSON.parse(stdout)).toEqual(snapshot);
      const f = fixture();
      const options = { input: f.input, output: f.output, prompt: f.prompt, environment: { CODEX_CONNECT_CONFIG_FILE: configPath } };
      f.prompt.confirm.mockResolvedValue(false);
      for (let i = 0; i < 130; i++) await runResetCreditCommand(["use", "credit-a"], options);
      expect(consume).not.toHaveBeenCalled();
      f.prompt.confirm.mockResolvedValue(true);
      await runResetCreditCommand(["use", "credit-a"], options);
      expect(consume).toHaveBeenCalledOnce();
      f.prompt.confirm.mockImplementationOnce(async () => { current.accountId = "account-b"; return true; });
      await expect(runResetCreditCommand(["use", "credit-a"], options)).rejects.toThrow("账户、券状态或确认已变化");
      expect(consume).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });
});
