import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initializeUserData } from "../scripts/runtime-config.mjs";
import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { serviceDefinitions } from "../runtime/service-targets.mjs";
import { serviceDefinitionPath } from "../scripts/service-selection.mjs";
import { mkdtempSync } from "./codexc-cli-test-fixture.js";

const mocks = vi.hoisted(() => ({
  control: vi.fn(), inspect: vi.fn(), waitCore: vi.fn(), waitRelay: vi.fn(), fetch: vi.fn(),
  events: [] as string[],
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => args[0] === "git"
      ? actual.spawnSync(...args)
      : mocks.control(...args),
  };
});
vi.mock("../scripts/service-status.mjs", () => ({ inspectManagedServiceStatusAsync: mocks.inspect }));
vi.mock("../scripts/local-installation.mjs", () => ({ waitForCoreServiceTarget: mocks.waitCore }));
vi.mock("../runtime/cli-presentation.mjs", () => ({ writeCliMessage: vi.fn() }));
vi.mock("../scripts/runtime-environment.mjs", async () => ({
  ...await vi.importActual("../scripts/runtime-environment.mjs"),
  configuredEnvironment: () => ({
    environment: process.env, configPath: process.env.CODEX_CONNECT_CONFIG_FILE!,
    document: readGatewayConfig(process.env.CODEX_CONNECT_CONFIG_FILE!),
  }),
}));
vi.mock("../scripts/service-selection.mjs", async () => ({
  ...await vi.importActual("../scripts/service-selection.mjs"), waitForSelectedRelay: mocks.waitRelay,
}));
const { runRestartCommand, runServiceCommand } = await import("../scripts/service-command.mjs");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.events.length = 0;
  root = mkdtempSync(join(tmpdir(), "codexc-restart-plan-"));
  for (const [name, value] of Object.entries({ HOME: root, USERPROFILE: root, CODEX_HOME: join(root, "codex"),
    CODEX_CONNECT_HOME: root, CODEX_CONNECT_CONFIG_FILE: join(root, "config.toml"),
    CODEX_CONNECT_SERVICE_ROLE: "", XDG_CONFIG_HOME: join(root, "config"),
  })) vi.stubEnv(name, value);
  initializeUserData({ environment: process.env, cwd: root });
  const config = readGatewayConfig(join(root, "config.toml"));
  config.telegram = { bot_token: "fixture", allowed_user_ids: [1] };
  config.model_relay = { enabled: true };
  writeGatewayConfig(join(root, "config.toml"), config);
  mocks.inspect.mockImplementation(async ({ target }: { target: string }) => {
    mocks.events.push(`inspect:${target}`);
    return { services: [{ loaded: true }] };
  });
  mocks.control.mockImplementation((_file: string, args: string[]) => {
    const index = args.findIndex(value => value.endsWith("-control.sh") || value.endsWith("-control.mjs"));
    mocks.events.push(`${args[index + 1]}:${args[index + 2]}`);
    return { status: 0 };
  });
  mocks.waitCore.mockImplementation(async (target: string) => { mocks.events.push(`ready:${target}`); });
  mocks.waitRelay.mockImplementation(async (target: string) => {
    if (target === "model-relay") mocks.events.push(`ready:${target}`);
  });
  mocks.fetch.mockImplementation(async () => { mocks.events.push("ready:webui"); return { ok: true }; });
  vi.stubGlobal("fetch", mocks.fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function install(platform: "linux" | "darwin" | "win32", targets = serviceDefinitions.map(definition => definition.target)) {
  const manager = ({ linux: "systemd", darwin: "launchd", win32: "windows" } as const)[platform];
  for (const definition of serviceDefinitions.filter(value => targets.includes(value.target))) {
    const path = serviceDefinitionPath(manager, definition, process.env);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "fixture");
  }
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

describe.each(["linux", "darwin", "win32"] as const)("%s restart orchestration", platform => {
  it("starts all selected services in dependency order and waits between starts", async () => {
    install(platform);
    await runServiceCommand(["start", "all"]);
    expect(mocks.events).toEqual([
      "start:app-server", "ready:app-server", "start:gateway", "ready:gateway",
      "start:model-relay", "ready:model-relay", "start:webui", "ready:webui",
    ]);
  });

  it("does not start later services after a readiness failure", async () => {
    install(platform);
    mocks.waitCore.mockRejectedValueOnce(new Error("not ready"));
    await expect(runServiceCommand(["start", "all"])).rejects.toThrow("not ready");
    expect(mocks.events).toEqual(["start:app-server"]);
  });

  it("distinguishes an unloaded launchd job from missing registered services", async () => {
    install(platform);
    mocks.inspect.mockResolvedValue({ services: [{ loaded: false }] });
    if (platform === "darwin") {
      await runRestartCommand(["webui"]);
      expect(mocks.events).toEqual(["check-install:undefined", "stop:webui", "start:webui", "ready:webui"]);
    } else {
      await expect(runRestartCommand(["webui"])).rejects.toThrow("尚未停止任何服务");
      expect(mocks.control).not.toHaveBeenCalled();
    }
  });

  it("preflights every target and waits for each service before starting its dependents", async () => {
    install(platform);
    const before = readFileSync(join(root, "config.toml"), "utf8");
    await runRestartCommand();
    expect(mocks.events).toEqual([
      "inspect:webui", "inspect:model-relay", "inspect:gateway", "inspect:app-server",
      ...(platform === "darwin" ? ["check-install:undefined"] : []),
      "stop:webui", "stop:model-relay", "stop:gateway", "stop:app-server",
      "start:app-server", "ready:app-server", "start:gateway", "ready:gateway",
      "start:model-relay", "ready:model-relay", "start:webui", "ready:webui",
    ]);
    const script = { linux: "systemd-control.sh", darwin: "launchd-control.sh", win32: "windows-service-control.mjs" }[platform];
    for (const call of mocks.control.mock.calls) expect(call[1].some((arg: string) => arg.endsWith(script))).toBe(true);
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8787/api/v1/health");
    expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(before);
  });

  it.each(["stop:webui", "stop:model-relay", "stop:gateway", "stop:app-server", "start:app-server", "start:gateway", "start:model-relay", "start:webui"])("aborts after %s fails and reports unfinished work", async failure => {
    install(platform);
    const control = mocks.control.getMockImplementation()!;
    mocks.control.mockImplementation((file, args) => {
      const result = control(file, args);
      return mocks.events.at(-1) === failure ? { status: 9 } : result;
    });
    await expect(runRestartCommand(["all"])).rejects.toThrow(/重启中止：[\s\S]*已完成：[\s\S]*未执行：[\s\S]*未自动回滚/u);
    expect(mocks.events.at(-1)).toBe(failure);
  });

  it.each(["app-server", "gateway", "model-relay"])("does not continue after %s readiness fails", async target => {
    install(platform);
    const wait = target === "model-relay" ? mocks.waitRelay : mocks.waitCore;
    wait.mockImplementation(async (value: string) => {
      if (target === value) throw new Error("fixture readiness failure");
    });
    await expect(runRestartCommand()).rejects.toThrow("fixture readiness failure");
    expect(mocks.events.at(-1)).toBe(`start:${target}`);
  });
});

it.skipIf(!existsSync("/bin/zsh")).each([
  ["all", "com.msola.codex-app-server"],
  ["gateway", "com.msola.codex-gateway"],
])("rejects restart %s before any mutation when launchd contains %s", async (target, unsupportedLabel) => {
  const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const launchctl = join(root, "launchctl");
  const log = join(root, "launchctl.log");
  writeFileSync(launchctl, [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$LAUNCHCTL_LOG"',
    'if [ "$1" = print ]; then',
    '  case "${2##*/}" in',
    '    "$UNSUPPORTED_LABEL"|com.hegenai.*) exit 0 ;;',
    '    *) exit 113 ;;',
    '  esac',
    'fi',
    'exit 1',
  ].join("\n"));
  chmodSync(launchctl, 0o700);
  vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  vi.stubEnv("NODE_BINARY", process.execPath);
  vi.stubEnv("LAUNCHCTL_LOG", log);
  vi.stubEnv("UNSUPPORTED_LABEL", unsupportedLabel);
  install("darwin");
  // Execute the actual controller so its startup restrictions cannot be hidden by a mock.
  mocks.control.mockImplementation((file, args, options) => spawnSync(file, args, { ...options, stdio: "pipe" }));
  await expect(runRestartCommand([target!])).rejects.toThrow();
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls.some(call => call.endsWith(`/${unsupportedLabel}`))).toBe(true);
  expect(calls.every(call => call.startsWith("print "))).toBe(true);
  expect(mocks.waitCore).not.toHaveBeenCalled();
  expect(mocks.waitRelay).not.toHaveBeenCalled();
});

it("skips uninstalled optional services and fails before stopping when a core service is missing", async () => {
  install("linux", ["gateway", "app-server"]);
  await runRestartCommand();
  expect(mocks.events.filter(value => value.startsWith("stop:"))).toEqual(["stop:gateway", "stop:app-server"]);
  mocks.events.length = 0;
  rmSync(serviceDefinitionPath("systemd", serviceDefinitions.find(value => value.target === "app-server")!, process.env));
  await expect(runRestartCommand()).rejects.toThrow("尚未停止任何服务");
  expect(mocks.events.every(value => value.startsWith("inspect:"))).toBe(true);
  await expect(runRestartCommand(["webui"])).rejects.toThrow("未安装");
});

it("stops a disabled Relay without restarting it in all, but permits explicit Relay process restart", async () => {
  install("linux");
  const config = readGatewayConfig(join(root, "config.toml"));
  config.model_relay = { enabled: false };
  writeGatewayConfig(join(root, "config.toml"), config);
  await runRestartCommand();
  expect(mocks.events).toContain("stop:model-relay");
  expect(mocks.events).not.toContain("start:model-relay");
  mocks.events.length = 0;
  await runRestartCommand(["relay"]);
  expect(mocks.events).toEqual(["inspect:model-relay", "stop:model-relay", "start:model-relay", "ready:model-relay"]);
});

it("rejects unreadable service state or invalid runtime configuration before any stop", async () => {
  install("linux");
  mocks.inspect.mockRejectedValueOnce(new Error("status unavailable"));
  await expect(runRestartCommand()).rejects.toThrow("status unavailable");
  expect(mocks.control).not.toHaveBeenCalled();
  const config = readGatewayConfig(join(root, "config.toml"));
  config.default_workspace = "missing";
  writeGatewayConfig(join(root, "config.toml"), config);
  await expect(runRestartCommand()).rejects.toThrow();
  expect(mocks.control).not.toHaveBeenCalled();
});

it("allows Gateway restart inside App Server without operating App Server", async () => {
  install("linux");
  vi.stubEnv("CODEX_CONNECT_SERVICE_ROLE", "app-server");
  await runRestartCommand(["gateway"]);
  expect(mocks.events).toEqual(["inspect:gateway", "stop:gateway", "start:gateway", "ready:gateway"]);
});

it("reports WebUI health failure without claiming restart success", async () => {
  install("linux");
  mocks.fetch.mockResolvedValue({ ok: false, status: 503 });
  vi.useFakeTimers();
  try {
    const failed = expect(runRestartCommand(["webui"])).rejects.toThrow("WebUI 启动后未就绪：HTTP 503");
    await vi.advanceTimersByTimeAsync(6000);
    await failed;
    expect(mocks.events).toEqual(["inspect:webui", "stop:webui", "start:webui"]);
  } finally { vi.useRealTimers(); }
});
