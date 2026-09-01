import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runCenterSettings, runConfig } from "../scripts/config.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
import { configActivationResult } from "../scripts/config-activation-result.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runWorkspaceCommand } from "../scripts/workspace-command.mjs";

const roots: string[] = [];

interface WorkspaceTable {
  id: string;
  name: string;
  sandbox?: string;
  approval_policy?: string;
  permissions?: string;
}

interface ConfigWithWorkspaces {
  workspaces: WorkspaceTable[];
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Codex Connect config menu", () => {
  it("prints configuration paths without prompts on a non-interactive output", async () => {
    const fixture = createFixture();
    const output: string[] = [];

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: false },
      prompts: {
        select: vi.fn(),
        isCancel: () => false,
      },
    });

    expect(result).toEqual({
      action: "paths",
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
    });
    expect(output.join("")).toContain("用户目录：");
    expect(output.join("")).toContain(`配置文件：${fixture.configPath}`);
  });

  it("prints JSON paths without requiring prompts or reading configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-config-json-"));
    roots.push(root);
    const configPath = join(root, "missing", "config.toml");
    const output: string[] = [];

    const result = await runConfig({
      environment: { CODEX_CONNECT_CONFIG_FILE: configPath },
      json: true,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts: null,
    });

    expect(result).toEqual({
      action: "paths",
      dataDir: join(root, "missing"),
      configPath,
      exists: false,
    });
    expect(JSON.parse(output.join(""))).toEqual({
      dataDir: join(root, "missing"),
      configPath,
      exists: false,
    });
  });

  it("sets the global price currency display through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("display")
        .mockResolvedValueOnce("price_currency")
        .mockResolvedValueOnce("cny"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({
      priceCurrency: "cny",
      configPath: fixture.configPath,
      activation: "restart-gateway",
      activationResult: configActivationResult("restart-gateway"),
    });
    expect(readGatewayConfig(fixture.configPath).display).toMatchObject({
      price_currency: "cny",
    });
    expect(output.join("")).toContain("全局价格显示方式已设为 cny");
    expect(output.join("")).toContain(
      "该设置需要重建 Gateway 连接；后台服务运行时会自动重启，前台进程需重新启动；未运行时将在下次启动生效；现有 Thread 不会被修改",
    );
  });

  it("prints a redacted Gateway configuration summary and keeps the menu open", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.telegram = {
      bot_token: "telegram-secret",
      allowed_user_ids: [123],
      message_format: "html",
    };
    document.network = { https_proxy: "http://proxy-user:proxy-secret@127.0.0.1:7890" };
    document.scheduled_tasks = { enabled: true };
    writeGatewayConfig(fixture.configPath, document);
    const output: string[] = [];
    const select = vi.fn()
      .mockResolvedValueOnce("summary")
      .mockResolvedValueOnce("cancel");

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });

    const rendered = output.join("");
    expect(rendered).toContain("Gateway 配置总览");
    expect(rendered).toContain("通讯渠道：Telegram");
    expect(rendered).toContain("计划任务：开启");
    expect(rendered).toContain("显式网络代理：https_proxy");
    expect(rendered).toContain("Codex 官方与第三方 Provider 配置由 codexc setup 管理");
    expect(rendered).not.toContain("telegram-secret");
    expect(rendered).not.toContain("proxy-secret");
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("shows a configured but disabled Weixin channel in the Gateway summary", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.weixin = {
      enabled: false,
      account_id: "bot-fixture@im.bot",
      allowed_user_ids: ["actor-fixture@im.wechat"],
    };
    writeGatewayConfig(fixture.configPath, document);
    const output: string[] = [];

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select: vi.fn()
          .mockResolvedValueOnce("summary")
          .mockResolvedValueOnce("cancel"),
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });

    const rendered = output.join("");
    expect(rendered).toContain("微信（已配置，未启用）");
    expect(rendered).not.toContain("Telegram（已配置，未启用）");
    expect(rendered).not.toContain("bot-fixture@im.bot");
    expect(rendered).not.toContain("actor-fixture@im.wechat");
  });

  it("formats the WebUI IPv6 loopback address unambiguously in the Gateway summary", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.webui = { host: "::1", port: 8787 };
    writeGatewayConfig(fixture.configPath, document);
    const output: string[] = [];

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select: vi.fn()
          .mockResolvedValueOnce("summary")
          .mockResolvedValueOnce("cancel"),
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });

    expect(output.join("")).toContain("WebUI：[::1]:8787");
  });

  it("toggles Gateway scheduled tasks through the automation menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select: vi.fn()
          .mockResolvedValueOnce("automation")
          .mockResolvedValueOnce("scheduled_tasks")
          .mockResolvedValueOnce("enabled"),
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });

    expect(result).toEqual({ scheduledTasksEnabled: true, configPath: fixture.configPath, activation: "restart-gateway", activationResult: configActivationResult("restart-gateway") });
    expect(readGatewayConfig(fixture.configPath).scheduled_tasks).toEqual({ enabled: true });
    expect(output.join("")).toContain("需要重建 Gateway 连接");
  });

  it("labels the scheduled task back button with its actual Config destination", async () => {
    const fixture = createFixture();
    const select = vi.fn()
      .mockResolvedValueOnce("automation")
      .mockResolvedValueOnce("scheduled_tasks")
      .mockImplementationOnce(async (options: {
        options: Array<{ value: string; label: string }>;
      }) => {
        expect(options.options).toContainEqual({ value: "back", label: "返回配置菜单" });
        return "back";
      })
      .mockResolvedValueOnce("cancel");

    await runConfig({
      environment: fixture.environment,
      output: { write: vi.fn(), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });
  });

  it("selects Thread Section administrators from enabled channel allowlists", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.telegram = {
      bot_token: "telegram-secret",
      allowed_user_ids: [123, 456],
      message_format: "html",
    };
    writeGatewayConfig(fixture.configPath, document);
    const multiselect = vi.fn(async (options: {
      options: Array<{ value: string; label: string }>;
    }) => {
      expect(options.options).toContainEqual({
        value: "telegram:456",
        label: "Telegram · 456",
      });
      return ["telegram:456"];
    });

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: vi.fn(), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select: vi.fn()
          .mockResolvedValueOnce("automation")
          .mockResolvedValueOnce("thread_sections"),
        multiselect,
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });

    expect(result).toEqual({
      threadSectionAdministrators: ["telegram:456"],
      configPath: fixture.configPath,
      activation: "restart-gateway",
      activationResult: configActivationResult("restart-gateway"),
    });
    expect(readGatewayConfig(fixture.configPath).thread_sections).toEqual({
      administrators: ["telegram:456"],
    });
  });

  it("updates a proxy without echoing credentials and requires service reinstall", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const proxy = "http://proxy-user:proxy-secret@127.0.0.1:7890";
    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select: vi.fn()
          .mockResolvedValueOnce("network")
          .mockResolvedValueOnce("https_proxy")
          .mockResolvedValueOnce("set"),
        text: vi.fn(async () => proxy),
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });

    expect(result).toEqual({ field: "https_proxy", configured: true, configPath: fixture.configPath, activation: "reinstall-services", activationResult: configActivationResult("reinstall-services") });
    expect(readGatewayConfig(fixture.configPath).network).toMatchObject({ https_proxy: proxy });
    expect(output.join("")).toContain("codexc service install");
    expect(output.join("")).not.toContain("proxy-secret");
  });

  it("writes HTTP, HTTPS and all proxy URLs in one operation", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const text = vi.fn()
      .mockResolvedValueOnce("http://127.0.0.1:7890")
      .mockResolvedValueOnce("http://127.0.0.1:7891")
      .mockResolvedValueOnce("http://127.0.0.1:7892");
    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select: vi.fn().mockResolvedValueOnce("network").mockResolvedValueOnce("batch"),
        text,
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });

    expect(result).toEqual({
      fields: ["http_proxy", "https_proxy", "all_proxy"],
      configPath: fixture.configPath,
      activation: "reinstall-services",
      activationResult: configActivationResult("reinstall-services"),
    });
    expect(readGatewayConfig(fixture.configPath).network).toEqual({
      http_proxy: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7891",
      all_proxy: "http://127.0.0.1:7892",
      no_proxy: "localhost,127.0.0.1",
    });
    expect(output.join("")).toContain("一次性更新");
    expect(text).toHaveBeenCalledTimes(3);
  });

  it("labels the network action back button with its actual Config destination", async () => {
    const fixture = createFixture();
    const select = vi.fn()
      .mockResolvedValueOnce("network")
      .mockResolvedValueOnce("https_proxy")
      .mockImplementationOnce(async (options: {
        options: Array<{ value: string; label: string }>;
      }) => {
        expect(options.options).toContainEqual({ value: "back", label: "返回配置菜单" });
        return "back";
      })
      .mockResolvedValueOnce("cancel");

    await runConfig({
      environment: fixture.environment,
      output: { write: vi.fn(), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });
  });

  it("configures the full log level and development Plugin API", async () => {
    const fixture = createFixture();
    await runConfig({
      environment: fixture.environment,
      output: { write: vi.fn(), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select: vi.fn()
          .mockResolvedValueOnce("advanced")
          .mockResolvedValueOnce("logging")
          .mockResolvedValueOnce("trace"),
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });
    await runConfig({
      environment: fixture.environment,
      output: { write: vi.fn(), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select: vi.fn()
          .mockResolvedValueOnce("advanced")
          .mockResolvedValueOnce("plugin_api")
          .mockResolvedValueOnce("enabled"),
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });

    const document = readGatewayConfig(fixture.configPath);
    expect(document.logging).toEqual({ level: "trace" });
    expect(document.experimental).toEqual({ plugin_api: true });
  });

  it("labels the Plugin API back button with its actual Config destination", async () => {
    const fixture = createFixture();
    const select = vi.fn()
      .mockResolvedValueOnce("advanced")
      .mockResolvedValueOnce("plugin_api")
      .mockImplementationOnce(async (options: {
        options: Array<{ value: string; label: string }>;
      }) => {
        expect(options.options).toContainEqual({ value: "back", label: "返回配置菜单" });
        return "back";
      })
      .mockResolvedValueOnce("cancel");

    await runConfig({
      environment: fixture.environment,
      output: { write: vi.fn(), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });
  });

  it("sets the global price currency to USD through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("display")
        .mockResolvedValueOnce("price_currency")
        .mockResolvedValueOnce("usd"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(readGatewayConfig(fixture.configPath).display).toMatchObject({
      price_currency: "usd",
    });
  });

  it("delegates the debug mode entry under system settings", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const debugSetup = vi.fn(async () => "debug-configured");
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("system")
        .mockResolvedValueOnce("debug"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
      debugSetup,
    });

    expect(result).toBe("debug-configured");
    expect(debugSetup).toHaveBeenCalledWith(expect.objectContaining({
      environment: fixture.environment,
    }));
  });

  it("toggles the operation detail display mode through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("display")
        .mockResolvedValueOnce("operation_updates")
        .mockResolvedValueOnce("full"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({ operationUpdates: "full", configPath: fixture.configPath, activation: "restart-gateway", activationResult: configActivationResult("restart-gateway") });
    expect(readGatewayConfig(fixture.configPath).display).toMatchObject({
      operation_updates: "full",
    });
    expect(output.join("")).toContain("操作详情显示已设为full");
  });

  it("toggles the plan update display through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("display")
        .mockResolvedValueOnce("plan_updates")
        .mockResolvedValueOnce("disabled"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({ planUpdatesEnabled: false, configPath: fixture.configPath, activation: "restart-gateway", activationResult: configActivationResult("restart-gateway") });
    expect(readGatewayConfig(fixture.configPath).display).toMatchObject({
      plan_updates: false,
    });
  });

  it("toggles the reasoning display through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("display")
        .mockResolvedValueOnce("reasoning")
        .mockResolvedValueOnce("disabled"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({ reasoningEnabled: false, configPath: fixture.configPath, activation: "restart-gateway", activationResult: configActivationResult("restart-gateway") });
    expect(readGatewayConfig(fixture.configPath).display).toMatchObject({
      reasoning: false,
    });
  });

  it("sets the approval timeout through the system settings", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("system")
        .mockResolvedValueOnce("approval_timeout"),
      text: vi.fn(async () => "120"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({ timeoutSeconds: 120, configPath: fixture.configPath, activation: "restart-gateway", activationResult: configActivationResult("restart-gateway") });
    expect(readGatewayConfig(fixture.configPath).approval).toEqual({
      timeout_seconds: 120,
    });
  });

  it("sets webui host and requires a token for non-loopback", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("webui")
        .mockResolvedValueOnce("host")
        .mockResolvedValueOnce("0.0.0.0"),
      password: vi.fn(async () => "webui-token"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({
      webui: { host: "0.0.0.0", port: 8787, tokenConfigured: true },
      configPath: fixture.configPath,
      activation: "restart-webui",
      activationResult: configActivationResult("restart-webui"),
    });
    expect(readGatewayConfig(fixture.configPath).webui).toEqual({
      host: "0.0.0.0",
      token: "webui-token",
    });
    expect(output.join("")).toContain("WebUI 设置已更新");
  });

  it("sets webui port and token through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("webui")
        .mockResolvedValueOnce("port"),
      text: vi.fn(async () => "9000"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });
    expect(readGatewayConfig(fixture.configPath).webui).toEqual({ port: 9000 });

    const tokenPrompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("webui")
        .mockResolvedValueOnce("token")
        .mockResolvedValueOnce("set"),
      password: vi.fn(async () => "webui-token"),
      isCancel: () => false,
      cancel: vi.fn(),
    };
    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts: tokenPrompts,
    });
    expect(readGatewayConfig(fixture.configPath).webui).toEqual({
      port: 9000,
      token: "webui-token",
    });
  });

  it("sets workspace sandbox and approval policy through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("permissions")
        .mockResolvedValueOnce("sandbox")
        .mockResolvedValueOnce("danger-full-access"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runWorkspaceCommand([], {
      cwd: fixture.dataDir,
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value) },
      outputIsTTY: true,
      prompts,
    });

    expect((readGatewayConfig(fixture.configPath) as unknown as ConfigWithWorkspaces).workspaces[0])
      .toMatchObject({ sandbox: "danger-full-access" });
    expect(output.join("")).toContain("已更新");
    expect(output.join("")).toContain("权限热加载");
  });

  it("sets a workspace approval policy through the menu", async () => {
    const fixture = createFixture();
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("permissions")
        .mockResolvedValueOnce("approval_policy")
        .mockResolvedValueOnce("never"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runWorkspaceCommand([], {
      cwd: fixture.dataDir,
      environment: fixture.environment,
      output: { write: () => {} },
      outputIsTTY: true,
      prompts,
    });

    expect((readGatewayConfig(fixture.configPath) as unknown as ConfigWithWorkspaces).workspaces[0])
      .toMatchObject({ approval_policy: "never" });
  });

  it("returns from Workspace permissions to the work menu", async () => {
    const fixture = createFixture();
    const select = vi.fn()
      .mockResolvedValueOnce("permissions")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("cancel");
    const prompts = {
      intro: vi.fn(),
      select,
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runWorkspaceCommand([], {
      cwd: fixture.dataDir,
      environment: fixture.environment,
      output: { write: vi.fn() },
      outputIsTTY: true,
      prompts,
    });

    expect(select).toHaveBeenCalledTimes(3);
    expect(prompts.cancel).toHaveBeenCalledWith("已取消");
  });

  it("rejects a permission profile when workspace sandbox is configured", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath) as unknown as ConfigWithWorkspaces;
    if (!Array.isArray(document.workspaces) || document.workspaces.length === 0) {
      throw new Error("测试配置缺少 Workspace");
    }
    document.workspaces[0]!.sandbox = "workspace-write";
    writeGatewayConfig(
      fixture.configPath,
      document as unknown as ReturnType<typeof readGatewayConfig>,
    );
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("permissions")
        .mockResolvedValueOnce("permissions")
        .mockResolvedValueOnce("back")
        .mockResolvedValueOnce("cancel"),
      text: vi.fn(async () => ":read-only"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runWorkspaceCommand([], {
      cwd: fixture.dataDir,
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value) },
      outputIsTTY: true,
      prompts,
    });

    expect(output.join("")).toContain("permissions 与 sandbox 互斥");
    expect((readGatewayConfig(fixture.configPath) as unknown as ConfigWithWorkspaces).workspaces[0])
      .not.toHaveProperty("permissions");
  });

  it("sets the Codex sandbox mode through the system settings", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("system")
        .mockResolvedValueOnce("sandbox")
        .mockResolvedValueOnce("read-only"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(readGatewayConfig(fixture.configPath).codex).toMatchObject({
      sandbox: "read-only",
    });
  });

  it("sets the default workspace through the system settings", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("system")
        .mockResolvedValueOnce("default_workspace")
        .mockResolvedValueOnce("codex-connect"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(readGatewayConfig(fixture.configPath).default_workspace).toBe(
      "codex-connect",
    );
  });

  it("sets or clears the default model through the system settings", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("system")
        .mockResolvedValueOnce("default_model"),
      text: vi.fn(async () => "gpt-5.6"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(readGatewayConfig(fixture.configPath).codex).toMatchObject({
      default_model: "gpt-5.6",
    });
  });

  it("sets the Telegram message format when Telegram is configured", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.telegram = {
      bot_token: "telegram-token",
      allowed_user_ids: [1],
      message_format: "html",
    };
    writeGatewayConfig(fixture.configPath, document);
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("message_format")
        .mockResolvedValueOnce("rich"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(readGatewayConfig(fixture.configPath).telegram).toMatchObject({
      message_format: "rich",
    });
  });

  it("hides Telegram-only settings until a Bot token is configured", async () => {
    const fixture = createFixture();
    const select = vi.fn().mockResolvedValueOnce("cancel");

    await runConfig({
      environment: fixture.environment,
      output: { write: vi.fn(), isTTY: true },
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: () => false,
        cancel: vi.fn(),
      },
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((option: { value: string }) => option.value))
      .not.toContain("message_format");
  });

  it("prints config paths and keeps the menu focused on settings", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const select = vi.fn()
      .mockResolvedValueOnce("paths")
      .mockResolvedValueOnce("cancel");
    const prompts = {
      intro: vi.fn(),
      select,
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(output.join("")).toContain(`配置文件：${fixture.configPath}`);
    const options = select.mock.calls[0]?.[0]?.options ?? [];
    const values = options.map((option: { value: string }) => option.value);
    expect(values).toContain("summary");
    expect(values).toContain("automation");
    expect(values).toContain("network");
    expect(values).toContain("advanced");
    expect(values).toContain("paths");
    expect(values).toContain("metrics");
    expect(values).not.toContain("workspaces");
    expect(values).not.toContain("doctor");
  });

  it("connects the local machine to a metrics center through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("metrics")
        .mockResolvedValueOnce("connect"),
      text: vi.fn()
        .mockResolvedValueOnce("http://127.0.0.1:8790")
        .mockResolvedValueOnce(""),
      password: vi.fn()
        .mockResolvedValueOnce("device-token")
        .mockResolvedValueOnce("view-token"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({
      endpoint: "http://127.0.0.1:8790",
      deviceId: null,
      configPath: fixture.configPath,
      activation: "restart-gateway-webui",
      activationResult: configActivationResult("restart-gateway-webui"),
      activationState: "pending",
    });
    const metrics = readGatewayConfig(fixture.configPath).metrics as unknown as {
      sync: { enabled: boolean; endpoint?: string; device_token?: string };
      view?: { enabled: boolean; endpoint?: string; token?: string };
    };
    expect(metrics.sync).toMatchObject({
      enabled: true,
      endpoint: "http://127.0.0.1:8790/api/ingest",
      device_token: "device-token",
    });
    expect(metrics.view).toEqual({
      enabled: true,
      endpoint: "http://127.0.0.1:8790",
      token: "view-token",
    });
    expect(output.join("")).toContain("已接入中心");
    expect(output.join("")).toContain("Gateway 与 WebUI 将分别重启以应用新配置");
    expect(output.join("")).toContain(
      "Gateway 与 WebUI 将分别重启以应用新配置：codexc service restart gateway；codexc service restart webui",
    );
  });

  it("prints the metrics connection status through the menu", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.metrics = {
      sync: {
        enabled: true,
        endpoint: "http://127.0.0.1:8790/api/ingest",
        device_token: "device-token",
        device_id: "device-a",
        batch_size: 200,
        interval_seconds: 60,
      },
      view: {
        enabled: true,
        endpoint: "http://127.0.0.1:8790",
        token: "view-token",
      },
    };
    writeGatewayConfig(fixture.configPath, document);
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("metrics")
        .mockResolvedValueOnce("status")
        .mockResolvedValueOnce("back")
        .mockResolvedValueOnce("cancel"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    const printed = output.join("");
    expect(printed).toContain("上报：已启用");
    expect(printed).toContain("上报端点：http://127.0.0.1:8790/api/ingest");
    expect(printed).toContain("设备 ID：device-a");
    expect(printed).toContain("WebUI 全局视图：已启用");
    expect(printed).toContain("设备上报令牌：已配置");
    expect(printed).toContain("全局查看令牌：已配置");
    expect(printed).not.toContain("device-token");
    expect(printed).not.toContain("view-token");
  });

  it("updates the metrics upload interval through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("metrics")
        .mockResolvedValueOnce("sync_params")
        .mockResolvedValueOnce("interval_seconds"),
      text: vi.fn(async () => "120"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({
      sync: { interval_seconds: 120 },
      configPath: fixture.configPath,
      activation: "restart-gateway",
      activationResult: configActivationResult("restart-gateway"),
    });
    const metrics = readGatewayConfig(fixture.configPath).metrics as unknown as {
      sync?: { interval_seconds: number; batch_size: number };
    };
    expect(metrics.sync).toMatchObject({
      interval_seconds: 120,
    });
    expect(output.join("")).toContain("上报参数已更新");
  });

  it("updates the local metrics retention policy through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("metrics")
        .mockResolvedValueOnce("storage"),
      text: vi.fn()
        .mockResolvedValueOnce("90")
        .mockResolvedValueOnce("250000"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({
      storage: { retention_days: 90, max_rows: 250_000 },
      configPath: fixture.configPath,
      activation: "restart-gateway",
      activationResult: configActivationResult("restart-gateway"),
    });
    expect(readGatewayConfig(fixture.configPath).metrics).toMatchObject({
      storage: { retention_days: 90, max_rows: 250_000 },
    });
    expect(output.join("")).toContain("本地指标保留策略已更新");
  });

  it("disables the metrics connection through the menu", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.metrics = {
      sync: {
        enabled: true,
        endpoint: "http://127.0.0.1:8790/api/ingest",
        device_token: "center-token",
        batch_size: 200,
        interval_seconds: 60,
      },
      view: {
        enabled: true,
        endpoint: "http://127.0.0.1:8790",
        token: "center-token",
      },
    };
    writeGatewayConfig(fixture.configPath, document);
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("metrics")
        .mockResolvedValueOnce("disable"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    const metrics = readGatewayConfig(fixture.configPath).metrics as unknown as {
      sync: { enabled: boolean };
      view?: { enabled: boolean };
    };
    expect(metrics.sync.enabled).toBe(false);
    expect(metrics.view?.enabled).toBe(false);
    expect(output.join("")).toContain("已停用中心接入");
  });

  it("configures the metrics center service through the shared settings function", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      select: vi.fn()
        .mockResolvedValueOnce("host")
        .mockResolvedValueOnce("127.0.0.1"),
      isCancel: () => false,
    };

    const result = await runCenterSettings({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
      writeConfig: writeGatewayConfig,
    });

    expect(result).toEqual({
      center: {
        enabled: false,
        host: "127.0.0.1",
        port: 8790,
        tokenConfigured: false,
        deviceTokenConfigured: false,
        databasePath: "data/central-metrics.sqlite3",
      },
      configPath: fixture.configPath,
      activation: "restart-center",
      activationResult: configActivationResult("restart-center"),
      activationState: "pending",
    });
    const center = readGatewayConfig(fixture.configPath).metrics as unknown as {
      center?: { enabled: boolean };
    };
    expect(center.center).toEqual({
      host: "127.0.0.1",
    });
    expect(output.join("")).toContain("中心服务设置已更新");
  });

  it("configures separate metrics center view and device tokens", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const writeToken = async (section: "token" | "device_token", value: string) =>
      runCenterSettings({
        environment: fixture.environment,
        output: { write: (message: string) => output.push(message), isTTY: true },
        prompts: {
          select: vi.fn()
            .mockResolvedValueOnce(section)
            .mockResolvedValueOnce("set"),
          password: vi.fn().mockResolvedValueOnce(value),
          isCancel: () => false,
        },
        writeConfig: writeGatewayConfig,
      });

    await writeToken("token", "view-token");
    await writeToken("device_token", "device-token");

    const center = (readGatewayConfig(fixture.configPath).metrics as unknown as {
      center?: { token?: string; device_token?: string };
    }).center;
    expect(center).toMatchObject({
      token: "view-token",
      device_token: "device-token",
    });
  });
});

function createFixture(): {
  configPath: string;
  dataDir: string;
  environment: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "codexc-config-menu-"));
  roots.push(root);
  const home = join(root, ".codex-connect");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  const initialized = initializeUserData({ environment, cwd: workspace });
  return {
    configPath: initialized.configPath,
    dataDir: home,
    environment,
  };
}
