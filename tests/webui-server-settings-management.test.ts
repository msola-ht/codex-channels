import { readCodexProxySettings, writeCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import * as childProcess from "node:child_process";
import * as filesystem from "node:fs/promises";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { loadGatewaySettings } from "../scripts/config-management.mjs";
import * as configManagement from "../scripts/config-management.mjs";
import * as privateFile from "../runtime/private-file.mjs";
// @ts-expect-error JavaScript helper intentionally has no declaration file.
import * as serviceStatus from "../scripts/webui-service-status.mjs";
import type { CodexUserConfigClient } from "../scripts/codex-user-config.mjs";
import {
  loadCodexUserSettings,
  previewCodexUserSetting,
  updateCodexUserSetting,
} from "../scripts/codex-user-settings-management.mjs";
import {
  cleanupWebuiTestFixtures,
  createWebuiTestFixture,
  startWebuiTestServer,
  type WebuiTestServer,
  type WebuiTestServerOptions,
} from "./webui-server-test-fixture.js";

const temporaryDirectories: string[] = [];
const servers: WebuiTestServer[] = [];

vi.mock("node:child_process", { spy: true });
vi.mock("node:fs/promises", { spy: true });

afterEach(async () => {
  await cleanupWebuiTestFixtures(servers, temporaryDirectories);
});

function createFixture() {
  return createWebuiTestFixture(temporaryDirectories);
}

function startServer(
  environment: NodeJS.ProcessEnv,
  staticDir?: string,
  options: WebuiTestServerOptions = {},
) {
  return startWebuiTestServer(servers, environment, staticDir, options);
}

describe("webui server settings and task management", () => {
  it("previews Workspace reviewers without writing and requires versioned one-time confirmation", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const url = `${origin}/api/v1/management/settings`;
    const headers = { authorization: "Bearer webui-token", origin: managementOrigin, "content-type": "application/json" };
    for (const value of ["auto_review", "user", null]) {
      const current = await (await fetch(url, { headers })).json() as { revision: string; system: { workspaces: Array<{ id: string; approvalsReviewer: string | null }> } };
      const workspace = current.system.workspaces[0]!;
      const setting = { kind: "workspace.permissions", value: { workspaceId: workspace.id, update: { kind: "approvals-reviewer", value } } };
      const body = { revision: current.revision, setting };
      const denied = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });
      expect(denied.status).toBe(409);
      const preview = await fetch(`${url}/preview`, { method: "POST", headers, body: JSON.stringify(body) });
      expect(preview.status, await preview.clone().text()).toBe(200);
      const confirmation = await preview.json() as { confirmationRequired: boolean; confirmationToken: string };
      expect(confirmation.confirmationRequired).toBe(true);
      expect(loadGatewaySettings(fixture.environment).workspaces[0]!.approvalsReviewer).toBe(workspace.approvalsReviewer);
      const confirmed = { ...body, confirmationToken: confirmation.confirmationToken };
      const saved = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(confirmed) });
      expect(saved.status, await saved.clone().text()).toBe(200);
      expect(loadGatewaySettings(fixture.environment).workspaces[0]!.approvalsReviewer).toBe(value);
      const fresh = await (await fetch(url, { headers })).json() as typeof current;
      expect(fresh.system.workspaces[0]!.approvalsReviewer).toBe(value);
      const replay = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(confirmed) });
      expect(replay.status).toBe(409);
    }
  });

  it("keeps shared proxy previews read-only and writes dotenv only after confirmation", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
    const url = `${origin}/api/v1/management/settings`;
    const current = await (await fetch(url)).json() as { revision: string };
    const headers = { origin: managementOrigin, "content-type": "application/json" };
    const body = { revision: current.revision, setting: { kind: "network.proxy", field: "https_proxy", action: "set", value: "http://localhost:7897" } };
    const before = readCodexProxySettings(fixture.environment);
    const denied = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });
    expect(denied.status).not.toBe(200);
    expect(readCodexProxySettings(fixture.environment)).toEqual(before);
    const preview = await fetch(`${url}/preview`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(preview.status).toBe(200);
    const confirmation = await preview.json() as { confirmationToken: string };
    expect(readCodexProxySettings(fixture.environment)).toEqual(before);
    const saved = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ ...body, confirmationToken: confirmation.confirmationToken }) });
    expect(saved.status).toBe(200);
    expect(readCodexProxySettings(fixture.environment)).toEqual({ https_proxy: "http://localhost:7897" });
    expect(readGatewayConfig(join(fixture.home, "config.toml"))).not.toHaveProperty("network");
  });

  it("reads traffic recording configuration without probing services or requiring management access", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const { origin } = await startServer(fixture.environment, undefined, { token: "webui-token" });
    const url = `${origin}/api/v1/settings/traffic`;
    const headers = { authorization: "Bearer webui-token", origin: "https://remote.example" };
    const probes = vi.spyOn(serviceStatus, "loadServiceStatusSummary");
    const completeSettings = vi.spyOn(configManagement, "loadGatewaySettings");
    const repairDirectory = vi.spyOn(privateFile, "securePrivateDirectorySync");
    const repairFile = vi.spyOn(privateFile, "securePrivateFileSync");
    const synchronous = vi.spyOn(childProcess, "spawnSync");
    const asynchronous = vi.spyOn(childProcess, "execFile");
    try {
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers })).status).toBe(405);
      for (const enabled of [false, true, false]) {
        const document = readGatewayConfig(configPath);
        document.debug = { model_traffic_dump: enabled };
        writeGatewayConfig(configPath, document);
        repairDirectory.mockClear();
        repairFile.mockClear();
        synchronous.mockClear();
        asynchronous.mockClear();
        const response = await fetch(url, { headers });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ modelTrafficDumpEnabled: enabled });
        expect(repairDirectory).not.toHaveBeenCalled();
        expect(repairFile).not.toHaveBeenCalled();
        expect(synchronous).not.toHaveBeenCalled();
        if (process.platform === "win32") expect(asynchronous).toHaveBeenCalledOnce();
      }
      expect(probes).not.toHaveBeenCalled();
      expect(completeSettings).not.toHaveBeenCalled();
    } finally {
      probes.mockRestore();
      completeSettings.mockRestore();
      repairDirectory.mockRestore();
      repairFile.mockRestore();
      synchronous.mockRestore();
      asynchronous.mockRestore();
    }
  });

  it("rejects invalid current configuration without exposing its contents or stale enablement", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const { origin } = await startServer(fixture.environment);
    const url = `${origin}/api/v1/settings/traffic`;
    const document = readGatewayConfig(configPath);
    document.debug = { model_traffic_dump: true };
    writeGatewayConfig(configPath, document);
    expect(await (await fetch(url)).json()).toEqual({ modelTrafficDumpEnabled: true });
    const before = readFileSync(configPath, "utf8");
    for (const invalid of [before.replace("version = 1", "version = 2"),
      before.replace("model_traffic_dump = true", 'model_traffic_dump = "secret-value"'),
      `${before}\n[unsupported]\nvalue = "secret-value"\n`]) {
      writeFileSync(configPath, invalid);
      const response = await fetch(url);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: {
        code: "configuration_unavailable",
        message: "Gateway 配置不可用，请检查配置格式和私有文件权限",
      } });
      expect(readFileSync(configPath, "utf8")).toBe(invalid);
    }
    writeFileSync(configPath, before);
    expect(await (await fetch(url)).json()).toEqual({ modelTrafficDumpEnabled: true });
  });

  it.skipIf(process.platform === "win32")("refuses unsafe config permissions without repairing them", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const { origin } = await startServer(fixture.environment);
    chmodSync(configPath, 0o644);
    expect((await fetch(`${origin}/api/v1/settings/traffic`)).status).toBe(503);
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
    chmodSync(configPath, 0o600);
    chmodSync(fixture.home, 0o722);
    expect((await fetch(`${origin}/api/v1/settings/traffic`)).status).toBe(503);
    expect(statSync(fixture.home).mode & 0o777).toBe(0o722);
    chmodSync(fixture.home, 0o700);
    expect((await fetch(`${origin}/api/v1/settings/traffic`)).status).toBe(200);
  });

  it("coalesces only in-flight reads, keeps the listener responsive and cancels abandoned reads", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);
    let finish: ((value: string) => void) | undefined;
    let signal: AbortSignal | undefined;
    const read = vi.spyOn(privateFile, "readPrivateConfigFile").mockImplementation((_path, options) => {
      signal = options?.signal;
      return new Promise((resolve, reject) => {
        finish = resolve;
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    try {
      const controllers = [new AbortController(), new AbortController()];
      const requests = controllers.map(controller => fetch(`${origin}/api/v1/settings/traffic`, { signal: controller.signal }).catch(() => null));
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      expect((await fetch(`${origin}/api/v1/time`)).status).toBe(200);
      expect((await fetch(`${origin}/api/v1/health`)).status).toBe(200);
      controllers[0]!.abort();
      await requests[0];
      expect(signal?.aborted).toBe(false);
      finish!(readFileSync(join(fixture.home, "config.toml"), "utf8"));
      expect(await (await requests[1])!.json()).toEqual({ modelTrafficDumpEnabled: false });
      const controller = new AbortController();
      const abandoned = fetch(`${origin}/api/v1/settings/traffic`, { signal: controller.signal }).catch(() => null);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      controller.abort();
      await abandoned;
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    } finally { read.mockRestore(); }
  });

  it.skipIf(process.platform === "win32")("starts a fresh read when a subscriber returns before cancellation finishes", async () => {
    const fixture = createFixture();
    const { origin, server } = await startServer(fixture.environment);
    const actualOpen = filesystem.open;
    let release: (() => void) | undefined;
    const open = vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { release = resolve; });
      return actualOpen(...args);
    });
    const read = vi.spyOn(privateFile, "readPrivateConfigFile");
    const controllers = [new AbortController(), new AbortController()];
    const requests: Array<Promise<Response | null>> = [];
    let arrived = false;
    const received = () => { arrived = true; };
    try {
      requests.push(fetch(`${origin}/api/v1/settings/traffic`, { signal: controllers[0]!.signal }).catch(() => null));
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const oldSignal = read.mock.calls[0]![1]?.signal;
      controllers[0]!.abort();
      await requests[0];
      await vi.waitFor(() => expect(oldSignal?.aborted).toBe(true));
      server.once("request", received);
      requests.push(fetch(`${origin}/api/v1/settings/traffic`, { signal: controllers[1]!.signal }).catch(() => null));
      await vi.waitFor(() => expect(arrived).toBe(true));
      expect(read).toHaveBeenCalledOnce();
      release!();
      const response = await requests[1];
      expect(response?.status).toBe(200);
      expect(await response!.json()).toEqual({ modelTrafficDumpEnabled: false });
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls[1]![1]?.signal?.aborted).toBe(false);
    } finally {
      release?.();
      controllers.forEach(controller => controller.abort());
      await Promise.all(requests);
      server.off("request", received);
      read.mockRestore();
      open.mockRestore();
    }
  });

  it("returns a redacted settings summary", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const document = readGatewayConfig(configPath);
    document.webui = { token: "webui-secret" };
    writeCodexProxySettings({ https_proxy: "http://proxy-user:proxy-secret@proxy.invalid" }, fixture.environment);
    writeGatewayConfig(configPath, document);
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/settings/summary`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      revision: string;
      gateway: {
        webui: { tokenConfigured: boolean };
        network: { configuredFields: string[] };
        metrics: { storage: { retentionDays: number; maxRows: number } };
        system: { modelTrafficDumpEnabled: boolean; modelTrafficRetentionDays: number };
      };
      services: { available: boolean; entries: Array<{ target: string }> };
      cli: Array<{ command: string }>;
    };
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.gateway).toMatchObject({
      webui: { tokenConfigured: true },
      network: { configuredFields: ["https_proxy"] },
      metrics: { storage: { retentionDays: 365, maxRows: 1_000_000 } },
      system: { modelTrafficDumpEnabled: false, modelTrafficRetentionDays: 30 },
    });
    expect(body.services.entries).toBeInstanceOf(Array);
    expect(new Set(body.services.entries.map((entry) => entry.target))).toEqual(new Set([
      "app-server",
      "gateway",
      "model-relay",
      "webui",
    ]));
    expect(body.cli.map((entry) => entry.command)).toContain("codexc status all");
    expect(body.cli.map((entry) => entry.command)).toContain("codexc status webui");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("webui-secret");
    expect(serialized).not.toContain("proxy-secret");
    expect(serialized).not.toContain(configPath);
  });

  it("previews and starts a confirmed source maintenance task without replay", async () => {
    const fixture = createFixture();
    const executableDirectory = mkdtempSync(join(tmpdir(), "codexc-webui-task-route-"));
    temporaryDirectories.push(executableDirectory);
    const executable = process.platform === "win32" ? join(executableDirectory, "codexc.cmd") : join(executableDirectory, "codexc");
    if (process.platform === "win32") {
      writeFileSync(executable, "@echo off\r\nexit /b 0\r\n", { mode: 0o700 });
    } else {
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      chmodSync(executable, 0o700);
    }
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(
      { ...fixture.environment, PATH: executableDirectory + delimiter },
      undefined,
      { token: "webui-token", managementOrigin },
    );
    const headers = { authorization: "Bearer webui-token", origin: managementOrigin, "content-type": "application/json" };
    const controller = new AbortController();
    const notifications = await fetch(`${origin}/api/v1/management/tasks/events`, { headers, signal: controller.signal });
    expect(notifications.status).toBe(200);
    expect(notifications.headers.get("content-type")).toContain("text/event-stream");
    const reader = notifications.body!.getReader();
    const decoder = new TextDecoder();
    let streamed = "";
    const receiving = (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          streamed += decoder.decode(chunk.value, { stream: true });
        }
      } catch { if (!controller.signal.aborted) throw new Error("任务通知意外断开"); }
    })();
    try {
      for (const input of [{ operation: "update" }, { operation: "update", action: "source" }]) {
        const rejected = await fetch(`${origin}/api/v1/management/tasks/preview`, {
          method: "POST", headers, body: JSON.stringify(input),
        });
        expect(rejected.status).toBe(400);
      }
      const preview = await fetch(`${origin}/api/v1/management/tasks/preview`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operation: "service", action: "reload" }),
      });
      expect(preview.status).toBe(200);
      const previewBody = await preview.json() as { confirmationToken: string };
      const startBody = { operation: "service", action: "reload", confirmationToken: previewBody.confirmationToken };
      const rejectedStart = await fetch(`${origin}/api/v1/management/tasks`, {
        method: "POST", headers,
        body: JSON.stringify({ operation: "update", action: "source", confirmationToken: previewBody.confirmationToken }),
      });
      expect(rejectedStart.status).toBe(400);
      const started = await fetch(`${origin}/api/v1/management/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify(startBody),
      });
      expect(started.status).toBe(202);
      const taskId = (await started.json() as { id: string }).id;

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const list = await fetch(`${origin}/api/v1/management/tasks`, { headers: { authorization: "Bearer webui-token" } });
        expect(list.status).toBe(200);
        const task = (await list.json() as { tasks: Array<{ id: string; state: string }> }).tasks.find((candidate) => candidate.id === taskId);
        if (task?.state === "completed") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        if (attempt === 99) throw new Error("管理任务未在预期时间内完成");
      }

      const replay = await fetch(`${origin}/api/v1/management/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify(startBody),
      });
      expect(replay.status).toBe(409);
      for (let attempt = 0; (streamed.match(/"changed"/gu) ?? []).length < 4; attempt += 1) {
        if (attempt === 99) throw new Error("未收到任务终态通知");
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
      expect(streamed).not.toContain(taskId);
      expect(streamed).not.toContain("webui-token");
      expect(streamed.trim().split("\n\n").every(frame => /^data: \{"type":"(?:changed|heartbeat)"\}$/u.test(frame))).toBe(true);
    } finally { controller.abort(); await receiving; reader.releaseLock(); }
  });

  it("authenticates task notifications and bounds shared subscriptions", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment, undefined, { token: "webui-token" });
    const url = `${origin}/api/v1/management/tasks/events`, headers = { authorization: "Bearer webui-token" };
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(`${url}?token=webui-token`, { headers })).status).toBe(400);
    expect((await fetch(url, { headers: { ...headers, origin: "https://evil.invalid" } })).status).toBe(403);
    const controllers: AbortController[] = [], responses: Response[] = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const controller = new AbortController(); controllers.push(controller);
        const response = await fetch(url, { headers, signal: controller.signal }); responses.push(response);
        expect(response.status).toBe(200);
      }
      expect((await fetch(url, { headers })).status).toBe(429);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(responses.map(response => response.body?.cancel().catch(() => undefined)));
    }
  });

  it("previews traffic cleanup with recognized dump counts", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { token: "webui-token", managementOrigin },
    );
    const response = await fetch(`${origin}/api/v1/management/tasks/preview`, {
      method: "POST",
      headers: {
        authorization: "Bearer webui-token",
        origin: managementOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "traffic", action: "cleanup" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      preview: {
        operation: "traffic",
        action: "cleanup",
        resource: {
          dumps: { bytes: 0, labels: 0, v2Sessions: 0 },
        },
      },
      confirmationToken: expect.any(String),
    });
  });

  it("requires a one-time confirmation for secret-bearing Gateway settings", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { token: "webui-token", managementOrigin });
    const headers = { authorization: "Bearer webui-token", origin: managementOrigin, "content-type": "application/json" };
    const current = await (await fetch(`${origin}/api/v1/management/settings`, { headers })).json() as { revision: string };
    const preview = await fetch(`${origin}/api/v1/management/settings/preview`, { method: "POST", headers, body: JSON.stringify({ revision: current.revision, setting: { kind: "webui.token", action: "set", value: "new-secret" } }) });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { confirmationToken?: string; confirmationRequired?: boolean };
    expect(previewBody.confirmationRequired).toBe(true);
    expect(previewBody.confirmationToken).toEqual(expect.any(String));
    const update = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers, body: JSON.stringify({ revision: current.revision, confirmationToken: previewBody.confirmationToken, setting: { kind: "webui.token", action: "set", value: "new-secret" } }) });
    expect(update.status).toBe(200);
  });

  it("allows loopback settings management without a configured WebUI token", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });

    const settings = await fetch(`${origin}/api/v1/management/settings`);
    expect(settings.status).toBe(200);
    const body = await settings.json() as { revision: string };

    const update = await fetch(`${origin}/api/v1/management/settings`, {
      method: "PATCH",
      headers: {
        origin: managementOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: body.revision,
        setting: { kind: "display.reasoning", value: false },
      }),
    });
    expect(update.status).toBe(200);
    expect(loadGatewaySettings(fixture.environment).display.reasoningEnabled).toBe(false);
  });

  it("sets the shared capture mode through the existing settings route", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
    const current = await (await fetch(`${origin}/api/v1/management/settings`)).json() as { revision: string };
    const response = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH",
      headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({ revision: current.revision, setting: { kind: "system.model-traffic-mode", value: "debug" } }) });
    expect(response.status).toBe(200);
    const settings = loadGatewaySettings(fixture.environment);
    expect(settings.system).toMatchObject({ modelTrafficMode: "debug", modelTrafficDumpEnabled: false });
    const invalid = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH",
      headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({ revision: settings.revision, setting: { kind: "system.model-traffic-mode", value: "unknown" } }) });
    expect(invalid.status).toBe(400);
    expect(loadGatewaySettings(fixture.environment).system.modelTrafficMode).toBe("debug");
  });

  it("updates traffic retention through WebUI settings management", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
    const current = await (await fetch(`${origin}/api/v1/management/settings`)).json() as {
      revision: string;
      system: { modelTrafficDumpEnabled: boolean; modelTrafficRetentionDays: number };
    };
    expect(current.system).toMatchObject({
      modelTrafficDumpEnabled: false,
      modelTrafficRetentionDays: 30,
    });

    const update = await fetch(`${origin}/api/v1/management/settings`, {
      method: "PATCH",
      headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        revision: current.revision,
        setting: { kind: "system.model-traffic-retention-days", value: 14 },
      }),
    });

    expect(update.status).toBe(200);
    expect(loadGatewaySettings(fixture.environment).system.modelTrafficRetentionDays).toBe(14);
  });

  it("protects low-risk management writes with the same WebUI token", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const unauthorized = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: managementOrigin } });
    expect(unauthorized.status).toBe(401);
    const settings = await fetch(`${origin}/api/v1/management/settings`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(settings.status).toBe(200);
    const body = await settings.json() as { revision: string };
    const update = await fetch(`${origin}/api/v1/management/settings`, {
      method: "PATCH",
      headers: {
        origin: managementOrigin,
        authorization: "Bearer webui-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: body.revision,
        setting: { kind: "display.reasoning", value: false },
      }),
    });
    expect(update.status).toBe(200);
    expect(loadGatewaySettings(fixture.environment).display.reasoningEnabled).toBe(false);
    const legacyLogin = await fetch(`${origin}/api/v1/management/login`, {
      method: "POST",
      headers: {
        origin: managementOrigin,
        authorization: "Bearer webui-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(legacyLogin.status).toBe(404);
  });

  it("does not expose arbitrary metrics database paths through WebUI management", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const headers = {
      origin: managementOrigin,
      authorization: "Bearer webui-token",
      "content-type": "application/json",
    };
    const current = await (await fetch(`${origin}/api/v1/management/settings`, { headers })).json() as { revision: string };
    const response = await fetch(`${origin}/api/v1/management/settings/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: current.revision, setting: { kind: "metrics.storage.database-path", value: "/tmp/redirected.sqlite3" } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "setting_not_allowed" } });
  });

  it.each(["tool-access", "permissions", "approvals-reviewer"])("requires a one-time confirmation before changing %s", async (kind) => {
    const fixture = createFixture();
    const setting = kind === "approvals-reviewer"
      ? { kind, value: "auto_review" }
      : { kind, path: ["computer_use", "default_app_access"], value: "allow" };
    const revision = `sha256:${"a".repeat(64)}`;
    let writes = 0;
    const result = { kind, previousVersion: revision, value: { ...(setting.path === undefined ? {} : { path: setting.path }), value: setting.value }, activation: "next-thread" as const };
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token", managementOrigin,
      loadCodexSettings: async () => ({ version: revision }),
      previewCodexSetting: async () => result,
      updateCodexSetting: async () => { writes += 1; return result; },
    });
    const headers = { authorization: "Bearer webui-token", origin: managementOrigin, "content-type": "application/json" };
    const body = { revision, setting };
    const url = `${origin}/api/v1/management/codex/settings`;
    const denied = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });
    expect(denied.status).toBe(409);
    expect(writes).toBe(0);
    const preview = await fetch(`${url}/preview`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const confirmation = await preview.json() as { confirmationRequired: boolean; confirmationToken: string };
    expect(confirmation.confirmationRequired).toBe(true);
    const confirmed = { ...body, confirmationToken: confirmation.confirmationToken };
    const saved = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(confirmed) });
    expect(saved.status).toBe(200);
    expect(writes).toBe(1);
    const replay = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(confirmed) });
    expect(replay.status).toBe(409);
    expect(writes).toBe(1);
  });

  it("reads, previews and writes App Server user settings through the shared management token", async () => {
    const fixture = createFixture();
    let settings = {
      version: "codex-v1",
      provider: "openai",
      defaultsEditable: true,
      models: [{ model: "gpt-test", displayName: "GPT Test", reasoningEfforts: [{ effort: "medium", description: "" }], defaultReasoningEffort: "medium", isDefault: true }],
      defaults: { model: "gpt-test", reasoningEffort: "medium", fastEnabled: false, webSearch: "disabled", updatePlanEnabled: false },
      permissions: { editable: true, defaultPermissions: null, sandboxMode: "read-only", approvalPolicy: "on-request", networkAccess: false },
    };
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token",
      managementOrigin: "http://127.0.0.1:0",
      loadCodexSettings: async () => settings,
      previewCodexSetting: async (input: unknown) => ({ kind: (input as { kind: string }).kind, previousVersion: settings.version, value: { enabled: true }, activation: "next-thread" as const }),
      updateCodexSetting: async (input: unknown) => { settings = { ...settings, version: "codex-v2" }; return { kind: (input as { kind: string }).kind, previousVersion: "codex-v1", value: { enabled: true }, activation: "next-thread" as const }; },
    });
    const headers = { authorization: "Bearer webui-token" };
    const read = await fetch(`${origin}/api/v1/management/codex/settings`, { headers });
    expect(read.status).toBe(200);
    expect((await read.json()).version).toBe("codex-v1");
    const preview = await fetch(`${origin}/api/v1/management/codex/settings/preview`, { method: "POST", headers: { ...headers, origin: "http://127.0.0.1:0", "content-type": "application/json" }, body: JSON.stringify({ revision: "codex-v1", setting: { kind: "fast", enabled: true } }) });
    expect(preview.status).toBe(200);
    expect((await preview.json()).activation.status).toBe("next-thread");
    const update = await fetch(`${origin}/api/v1/management/codex/settings`, { method: "PATCH", headers: { ...headers, origin: "http://127.0.0.1:0", "content-type": "application/json" }, body: JSON.stringify({ revision: "codex-v1", setting: { kind: "fast", enabled: true } }) });
    expect(update.status).toBe(200);
    expect((await update.json()).revision).toBe("codex-v2");
  });

  it("keeps Codex settings readable and unrelated writes available when reviewer policy is unavailable", async () => {
    const fixture = createFixture();
    let version = "codex-v1";
    const config = { approvals_reviewer: "auto_review", model: "gpt-test", service_tier: "default" };
    const client: CodexUserConfigClient = {
      connect: async () => undefined,
      close: async () => undefined,
      readUserConfigSnapshot: async () => ({ config, version }),
      listModels: async () => [],
      writeUserConfigEdits: vi.fn(async () => { config.service_tier = "fast"; version = "codex-v2"; }),
      readDefaultModelSettings: async () => ({ model: "gpt-test", effort: "medium" }),
      writeDefaultModelSettings: async () => undefined,
    };
    const dependencies = { createClient: async () => client, primaryProvider: () => "openai" };
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token", managementOrigin,
      loadCodexSettings: (options) => loadCodexUserSettings({ ...options, ...dependencies }),
      previewCodexSetting: (input, options) => previewCodexUserSetting(input as Parameters<typeof previewCodexUserSetting>[0], { ...options, ...dependencies }),
      updateCodexSetting: (input, options) => updateCodexUserSetting(input as Parameters<typeof updateCodexUserSetting>[0], { ...options, ...dependencies }),
    });
    const url = `${origin}/api/v1/management/codex/settings`;
    const headers = { authorization: "Bearer webui-token", origin: managementOrigin, "content-type": "application/json" };
    const read = await fetch(url, { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      version, defaults: { model: "gpt-test", fastEnabled: false },
      approvalsReviewer: { value: "auto_review", editable: false, reason: "unavailable" },
    });
    const reviewerBody = JSON.stringify({ revision: version, setting: { kind: "approvals-reviewer", value: "user" } });
    for (const [path, method] of [[`${url}/preview`, "POST"], [url, "PATCH"]] as const) {
      const denied = await fetch(path, { method, headers, body: reviewerBody });
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({ error: { code: "approvals-reviewer-unavailable" } });
    }
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
    const body = JSON.stringify({ revision: version, setting: { kind: "fast", enabled: true } });
    const preview = await fetch(`${url}/preview`, { method: "POST", headers, body });
    expect(preview.status).toBe(200);
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
    const saved = await fetch(url, { method: "PATCH", headers, body });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: "codex-v2", value: { enabled: true } });
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([{ keyPath: "service_tier", value: "fast" }], { expectedVersion: "codex-v1" });
  });

  it("returns one complete redacted configuration snapshot for the settings page", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const document = readGatewayConfig(configPath);
    document.webui = { host: "127.0.0.1", port: 8787, token: "webui-secret" };
    writeCodexProxySettings({ https_proxy: "http://proxy-user:proxy-secret@proxy.invalid" }, fixture.environment);
    writeGatewayConfig(configPath, document);
    const { origin } = await startServer(fixture.environment, undefined, { token: "webui-secret" });

    const response = await fetch(`${origin}/api/v1/management/settings`, {
      headers: { authorization: "Bearer webui-secret" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      system: { defaultWorkspace: string | null };
      network: { configuredFields: string[] };
      webui: { host: string; port: number; tokenConfigured: boolean };
      metrics: {
        storage: { retentionDays: number; maxRows: number };
      };
      channels: unknown[];
    };
    expect(body).toMatchObject({
      system: { defaultWorkspace: "codex-connect" },
      network: { configuredFields: ["https_proxy"] },
      webui: { host: "127.0.0.1", port: 8787, tokenConfigured: true },
      metrics: {
        storage: { retentionDays: 365, maxRows: 1_000_000 },
      },
      channels: expect.any(Array),
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("webui-secret");
    expect(serialized).not.toContain("proxy-secret");
  });

  it("normalizes structured metrics settings from the WebUI payload", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const settings = await fetch(`${origin}/api/v1/management/settings`, {
      headers: { authorization: "Bearer webui-token" },
    });
    const current = await settings.json() as {
      revision: string;
      metrics: {
        storage: { retentionDays: number; maxRows: number };
      };
    };
    const retentionDays = current.metrics.storage.retentionDays === 30 ? 90 : 30;
    const preview = await fetch(`${origin}/api/v1/management/settings/preview`, {
      method: "POST",
      headers: {
        origin: managementOrigin,
        authorization: "Bearer webui-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: current.revision,
        setting: {
          kind: "metrics.storage",
          value: { retentionDays, maxRows: current.metrics.storage.maxRows },
        },
      }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ value: { storage: { retentionDays } } });

  });

  it("does not expose a second management login when loopback management is tokenless", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
    const response = await fetch(`${origin}/api/v1/management/login`, {
      method: "POST",
      headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("rejects management writes with stale revision and cross-origin requests", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const settings = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: managementOrigin, authorization: "Bearer webui-token" } });
    const current = await settings.json() as { revision: string; display: { reasoningEnabled: boolean } };
    const revision = current.revision;
    const changedValue = !current.display.reasoningEnabled;
    const crossOrigin = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers: { origin: "https://evil.example", authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision, setting: { kind: "display.reasoning", value: changedValue } }) });
    expect(crossOrigin.status).toBe(403);
    const first = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers: { origin: managementOrigin, authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision, setting: { kind: "display.reasoning", value: changedValue } }) });
    expect(first.status).toBe(200);
    const stale = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers: { origin: managementOrigin, authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision, setting: { kind: "display.reasoning", value: !changedValue } }) });
    expect(stale.status).toBe(409);
  });

  it("fails closed when management audit storage is unavailable", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const settings = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: managementOrigin, authorization: "Bearer webui-token" } });
    const current = await settings.json() as { revision: string; display: { reasoningEnabled: boolean } };
    const auditPath = join(fixture.home, "management-audit.jsonl");
    mkdirSync(auditPath);
    const update = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers: { origin: managementOrigin, authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision: current.revision, setting: { kind: "display.reasoning", value: !current.display.reasoningEnabled } }) });
    expect(update.status).toBe(500);
    expect((await update.json() as { error: { code: string } }).error.code).toBe("management_audit_unavailable");
    expect(loadGatewaySettings(fixture.environment).display.reasoningEnabled).toBe(current.display.reasoningEnabled);
  });

  it("rejects unauthorized, cross-origin, and unsupported management requests", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const unauthorized = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: managementOrigin } });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("x-content-type-options")).toBe("nosniff");
    const crossOrigin = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: "https://evil.example", authorization: "Bearer webui-token" } });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("x-content-type-options")).toBe("nosniff");
    const unsupported = await fetch(`${origin}/api/v1/management/settings/preview`, { method: "POST", headers: { origin: managementOrigin, authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision: "0".repeat(64), setting: { kind: "credentials.api-key", value: "secret" } }) });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json() as { error: { code: string } }).error.code).toBe("setting_not_allowed");
  });

  it("returns an actionable settings error before Gateway initialization", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-webui-uninitialized-"));
    temporaryDirectories.push(home);
    const { origin } = await startServer({
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    });

    for (const endpoint of ["summary", "traffic"]) {
      const response = await fetch(`${origin}/api/v1/settings/${endpoint}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "configuration_unavailable",
          message: "Gateway 尚未初始化，请先运行 codexc init",
        },
      });
    }
  });

});
