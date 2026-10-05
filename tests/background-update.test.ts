import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  active: undefined as string | undefined,
  job: {} as Record<string, unknown>,
  receipts: [] as Record<string, unknown>[],
}));
vi.mock("../scripts/background-update-state.mjs", async () => {
  const fs = await import("node:fs");
  return {
    updateRoot: (env: NodeJS.ProcessEnv) => join(env.CODEX_CONNECT_HOME!, "updates"),
    withUpdateLock: async (_root: string, callback: () => Promise<unknown>) => callback(),
    createUpdateDirectory: (root: string, id: string) => { const path = join(root, id); fs.mkdirSync(path, {recursive: true}); return path; },
    snapshotLocalSource: () => ({sourcePath: "/source with spaces", sourceCommit: "a".repeat(40), snapshotSha256: "b".repeat(64)}),
    copyUpdateRunner: vi.fn(),
    writeUpdateJob: (_root: string, job: Record<string, unknown>) => { state.job = job; },
    writeUpdateReceipt: (_root: string, _id: string, receipt: Record<string, unknown>) => { state.receipts.push(receipt); },
    readActiveUpdate: () => state.active,
    reserveUpdate: (_root: string, id: string) => { state.active = id; },
    releaseUpdate: () => { state.active = undefined; },
    readUpdateJob: () => state.job,
    readUpdateReceipt: () => state.receipts.at(-1),
    listUpdateJobIds: () => [state.job.id],
  };
});

import { backgroundUnitArguments, backgroundUpdateEnvironment, inspectBackgroundUpdate, submitBackgroundUpdate } from "../scripts/background-update.mjs";
import type { BackgroundUpdateJob } from "../scripts/background-update-state.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
  state.active = undefined; state.job = {}; state.receipts = [];
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "background-update-")); roots.push(root);
  const installed = join(root, "prefix/lib/node_modules/@hegenai/codexc");
  mkdirSync(installed, {recursive: true});
  writeFileSync(join(installed, "package.json"), JSON.stringify({name: "@hegenai/codexc"}));
  const config = join(root, "config.toml"); writeFileSync(config, "", {mode: 0o600});
  return { root, installed, environment: {CODEX_CONNECT_HOME: root, CODEX_CONNECT_CONFIG_FILE: config} };
}

describe("background local deployment submission", () => {
  it("escapes systemd command environment expansion without invoking a shell", () => {
    const job = {unitName: "test", environment: {}, nodeBinary: "/opt/${HOME}/node", id: "task"} as BackgroundUpdateJob;
    const args = backgroundUnitArguments(job, "/tmp/${HOME}/task");
    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      "/opt/$${HOME}/node", "/tmp/$${HOME}/task/runner/scripts/background-update-worker.mjs", "/tmp/$${HOME}", "task",
    ]);
  });
  it("passes only approved environment keys and no App Server role or secrets", () => {
    const env = backgroundUpdateEnvironment({HOME: "/home/u", PATH: "/unsafe", CODEX_CONNECT_SERVICE_ROLE: "app-server", OPENAI_API_KEY: "secret", HTTPS_PROXY: "secret"}, "/opt/node/bin/node", "/config.toml");
    expect(env).toEqual({HOME: "/home/u", PATH: "/opt/node/bin:/usr/local/bin:/usr/bin:/bin", CODEX_CONNECT_CONFIG_FILE: "/config.toml"});
  });
  it("schedules rescue before main without stopping services in the caller", async () => {
    const f = fixture(); const calls: string[][] = [];
    const result = await submitBackgroundUpdate("/source with spaces", f.environment, {platform: "linux", packageDirectory: f.installed, systemd: args => {calls.push(args); return "";} });
    expect(result.status).toBe("queued"); expect(state.active).toBe(result.id);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain(`--unit=codexc-update-${result.id}-rescue`);
    expect(calls[2]).toContain(`--unit=codexc-update-${result.id}`);
    expect(calls[2]).toContain(`--property=OnFailure=codexc-update-${result.id}-rescue.service`);
    expect(calls.flat()).not.toContain("--scope");
    expect(calls.flat()).not.toContain("stop");
    expect(calls[2]).toContain(join(result.jobDirectory, "runner/scripts/background-update-worker.mjs"));
  });
  it("rejects overlapping task before snapshot/submission", async () => {
    const f = fixture(); state.active = "existing";
    await expect(submitBackgroundUpdate("/source", f.environment, {platform: "linux", packageDirectory: f.installed, systemd: () => ""})).rejects.toThrow("已有后台");
    expect(state.receipts).toEqual([]);
  });
  it("rejects contaminated user manager environment", async () => {
    const f = fixture();
    await expect(submitBackgroundUpdate("/source", f.environment, {platform: "linux", packageDirectory: f.installed, systemd: () => "CODEX_CONNECT_SERVICE_ROLE=app-server"})).rejects.toThrow("角色标记");
    expect(state.receipts).toEqual([]);
  });
  it("retains reservation when submission and confirmed cancellation both fail", async () => {
    const f = fixture();
    await expect(submitBackgroundUpdate("/source", f.environment, {platform: "linux", packageDirectory: f.installed, systemd: args => {
      if (args.includes("show-environment")) return "";
      throw new Error("D-Bus failed");
    }})).rejects.toThrow("D-Bus failed");
    expect(state.receipts.at(-1)?.status).toBe("recovery-required");
    expect(state.active).toBeTruthy();
  });
  it("does not report a queued receipt as deployment success", async () => {
    const f = fixture();
    const submitted = await submitBackgroundUpdate("/source", f.environment, {platform: "linux", packageDirectory: f.installed, systemd: () => ""});
    const result = inspectBackgroundUpdate(submitted.id, f.environment, {systemd: () => {throw new Error("offline");}});
    expect(result.status).toBe("queued"); expect(result.serviceState).toBe("unknown");
  });
});
