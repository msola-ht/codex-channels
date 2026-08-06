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
import { runConfig } from "../scripts/config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";

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

  it("sets the global price currency display through the menu", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("display")
        .mockResolvedValueOnce("price_currency")
        .mockResolvedValueOnce("global")
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
      scope: "global",
      mode: "cny",
      configPath: fixture.configPath,
    });
    expect(readGatewayConfig(fixture.configPath).display).toMatchObject({
      price_currency: "cny",
    });
    expect(output.join("")).toContain("全局价格显示方式已设为 cny");
    expect(output.join("")).toContain("重启 Gateway 后生效");
  });

  it("sets a per-provider price currency override", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("display")
        .mockResolvedValueOnce("price_currency")
        .mockResolvedValueOnce("deepseek")
        .mockResolvedValueOnce("cny"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(readGatewayConfig(fixture.configPath).display).toMatchObject({
      price_currency_by_provider: { deepseek: "cny" },
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

    expect(result).toEqual({ operationUpdates: "full", configPath: fixture.configPath });
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

    expect(result).toEqual({ planUpdatesEnabled: false, configPath: fixture.configPath });
    expect(readGatewayConfig(fixture.configPath).display).toMatchObject({
      plan_updates: false,
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

    expect(result).toEqual({ timeoutSeconds: 120, configPath: fixture.configPath });
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
      webui: { host: "0.0.0.0", token: "webui-token" },
      configPath: fixture.configPath,
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
        .mockResolvedValueOnce("workspaces")
        .mockResolvedValueOnce("sandbox")
        .mockResolvedValueOnce("danger-full-access"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
      prompts,
    });

    expect(result).toEqual({
      workspaceId: "codex-connect",
      sandbox: "danger-full-access",
      approvalPolicy: undefined,
      permissions: undefined,
      configPath: fixture.configPath,
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
        .mockResolvedValueOnce("workspaces")
        .mockResolvedValueOnce("approval_policy")
        .mockResolvedValueOnce("never"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    const result = await runConfig({
      environment: fixture.environment,
      output: { write: () => {}, isTTY: true },
      prompts,
    });

    expect(result).toEqual({
      workspaceId: "codex-connect",
      sandbox: undefined,
      approvalPolicy: "never",
      permissions: undefined,
      configPath: fixture.configPath,
    });
    expect((readGatewayConfig(fixture.configPath) as unknown as ConfigWithWorkspaces).workspaces[0])
      .toMatchObject({ approval_policy: "never" });
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
        .mockResolvedValueOnce("workspaces")
        .mockResolvedValueOnce("permissions")
        .mockResolvedValueOnce("back")
        .mockResolvedValueOnce("cancel"),
      text: vi.fn(async () => ":read-only"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await runConfig({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value), isTTY: true },
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
    expect(values).toContain("paths");
    expect(values).not.toContain("metrics");
    expect(values).not.toContain("doctor");
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
