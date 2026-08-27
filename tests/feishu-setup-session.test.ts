import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  FeishuSetupSessionError,
  createFeishuSetupSession,
} from "../scripts/feishu-setup-session.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const appId = "cli_0123456789abcdef";
const appSecret = "application-secret";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Feishu Setup session", () => {
  it("keeps manual credentials private and saves only after owner confirmation", async () => {
    const fixture = createFixture({
      enabled: true,
      app_id: appId,
      app_secret: "old-secret",
      allowed_open_ids: ["ou_existing"],
    });
    const writeConfig = vi.fn(writeGatewayConfig);
    const session = createFeishuSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      createSessionId: () => "feishu-session",
      validateApplication: async (_credential, options) => {
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        return { openId: "ou_bot", name: "Manual Bot" };
      },
      writeConfig,
    });

    session.start("owner", { mode: "manual", appId, appSecret });
    const validated = await session.waitForReady("owner");

    expect(validated).toMatchObject({
      sessionId: "feishu-session",
      state: "validated",
      application: {
        mode: "manual",
        appId,
        botName: "Manual Bot",
        configuredAllowedOpenIds: ["ou_existing"],
      },
    });
    expect(JSON.stringify(validated)).not.toContain(appSecret);
    expect(() => session.status("other")).toThrowError(
      expect.objectContaining({ code: "owner-mismatch" }),
    );
    session.useAllowedOpenIds("owner", ["ou_existing", "ou_new"]);
    expect(session.status("owner").preview).toEqual({
      enabled: true,
      appId,
      botName: "Manual Bot",
      allowedOpenIds: ["ou_existing", "ou_new"],
    });
    expect(writeConfig).not.toHaveBeenCalled();

    const result = await session.confirm("owner");

    expect(result).toEqual({
      action: "configured",
      appId,
      allowedOpenIds: ["ou_existing", "ou_new"],
      configPath: fixture.configPath,
      activation: "restart-gateway",
      applicationConfiguration: "not-requested",
      warnings: [],
    });
    expect(JSON.stringify(result)).not.toContain(appSecret);
    expect(parseToml(readFileSync(fixture.configPath, "utf8")).feishu)
      .toMatchObject({
        enabled: true,
        app_id: appId,
        app_secret: appSecret,
        allowed_open_ids: ["ou_existing", "ou_new"],
      });
  });

  it("publishes scan progress and replaces the allowlist with the scanner", async () => {
    const fixture = createFixture({
      enabled: true,
      app_id: appId,
      app_secret: "old-secret",
      allowed_open_ids: ["ou_existing"],
    });
    const configureApplication = vi.fn(async (_credential, options) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return { changed: true };
    });
    const session = createFeishuSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      registerApplication: async (options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.addons).toMatchObject({ preset: false });
        options.onQRCodeReady({
          url: "https://accounts.feishu.cn/authorize?device=short-lived",
          expireIn: 480,
        });
        options.onStatusChange({ status: "slow_down" });
        return {
          client_id: appId,
          client_secret: appSecret,
          user_info: { open_id: "ou_scanner", tenant_brand: "feishu" },
        };
      },
      validateApplication: async () => ({
        openId: "ou_bot",
        name: "Scan Bot",
      }),
      configureApplication,
    });
    const states: string[] = [];
    session.subscribe("owner", (status) => states.push(status.state));

    session.start("owner", { mode: "scan" });
    const ready = await session.waitForReady("owner");

    expect(ready).toMatchObject({
      state: "ready",
      registrationStatus: "slow-down",
      application: { mode: "scan", appId, botName: "Scan Bot" },
      preview: {
        enabled: true,
        appId,
        botName: "Scan Bot",
        allowedOpenIds: ["ou_scanner"],
      },
    });
    expect(states).toEqual(expect.arrayContaining([
      "registering",
      "waiting-for-authorization",
      "validating",
      "ready",
    ]));
    expect(JSON.stringify(ready)).not.toContain(appSecret);

    const result = await session.confirm("owner");

    expect(result.applicationConfiguration).toBe("updated");
    expect(configureApplication).toHaveBeenCalledOnce();
    expect(parseToml(readFileSync(fixture.configPath, "utf8")).feishu)
      .toMatchObject({
        app_secret: appSecret,
        allowed_open_ids: ["ou_scanner"],
      });
  });

  it("aborts an in-flight registration when cancelled", async () => {
    const fixture = createFixture();
    let registrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const session = createFeishuSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      registerApplication: async (options) => {
        receivedSignal = options.signal;
        registrationStarted();
        return await new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { code: "abort" })),
            { once: true },
          );
        });
      },
    });

    session.start("owner", { mode: "scan" });
    const workflow = session.waitForReady("owner");
    await started;
    session.cancel("owner");

    await workflow;
    expect(receivedSignal?.aborted).toBe(true);
    expect(session.status("owner").state).toBe("cancelled");
  });

  it("expires validation and aborts its request", async () => {
    const fixture = createFixture();
    let receivedSignal: AbortSignal | undefined;
    const session = createFeishuSetupSession({
      ownerId: "owner",
      timeoutMs: 10,
    }, {
      environment: fixture.environment,
      validateApplication: async (_credential, options) => {
        receivedSignal = options?.signal;
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    });

    session.start("owner", { mode: "manual", appId, appSecret });
    await session.waitForReady("owner");

    expect(receivedSignal?.aborted).toBe(true);
    expect(session.status("owner").state).toBe("expired");
  });

  it("rejects untrusted authorization URLs without leaking credentials", async () => {
    const fixture = createFixture();
    const session = createFeishuSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      registerApplication: async (options) => {
        options.onQRCodeReady({
          url: "https://accounts.feishu.cn.example.com/authorize?secret=value",
          expireIn: 600,
        });
        throw new Error("unreachable");
      },
    });
    session.start("owner", { mode: "scan" });

    await expect(session.waitForReady("owner")).rejects.toSatisfy(
      (error: unknown) => error instanceof FeishuSetupSessionError
        && error.code === "invalid-authorization-url"
        && !error.message.includes("secret=value"),
    );
    expect(session.status("owner")).toMatchObject({
      state: "failed",
      error: { code: "invalid-authorization-url" },
    });
  });

  it("rejects stale saves and fails closed on write errors", async () => {
    const staleFixture = createFixture();
    const stale = manualSession(staleFixture.environment);
    stale.start("owner", { mode: "manual", appId, appSecret });
    await stale.waitForReady("owner");
    stale.useAllowedOpenIds("owner", ["ou_owner"]);
    const changed = readGatewayConfig(staleFixture.configPath);
    changed.feishu = {
      enabled: true,
      app_id: "cli_fedcba9876543210",
      app_secret: "external-secret",
      allowed_open_ids: ["ou_external"],
    };
    writeGatewayConfig(staleFixture.configPath, changed);

    await expect(stale.confirm("owner")).rejects.toThrowError(
      expect.objectContaining({ code: "stale-session" }),
    );
    expect(stale.status("owner").state).toBe("ready");
    stale.cancel("owner");

    const failedFixture = createFixture();
    const before = readFileSync(failedFixture.configPath, "utf8");
    const failed = createFeishuSetupSession({ ownerId: "owner" }, {
      environment: failedFixture.environment,
      validateApplication: async () => ({
        openId: "ou_bot",
        name: "Manual Bot",
      }),
      writeConfig: () => { throw new Error("disk unavailable"); },
    });
    failed.start("owner", { mode: "manual", appId, appSecret });
    await failed.waitForReady("owner");
    failed.useAllowedOpenIds("owner", ["ou_owner"]);

    await expect(failed.confirm("owner")).rejects.toThrow("disk unavailable");
    expect(failed.status("owner")).toMatchObject({
      state: "failed",
      error: { code: "save-failed" },
    });
    expect(readFileSync(failedFixture.configPath, "utf8")).toBe(before);
  });

  it("keeps a saved scan connection when application configuration fails", async () => {
    const fixture = createFixture();
    const session = createFeishuSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      registerApplication: async () => ({
        client_id: appId,
        client_secret: appSecret,
        user_info: { open_id: "ou_scanner", tenant_brand: "feishu" },
      }),
      validateApplication: async () => ({
        openId: "ou_bot",
        name: "Scan Bot",
      }),
      configureApplication: async () => {
        throw new Error("upstream secret response");
      },
    });
    session.start("owner", { mode: "scan" });
    await session.waitForReady("owner");

    const result = await session.confirm("owner");

    expect(result).toMatchObject({
      applicationConfiguration: "failed",
      warnings: [{ code: "application-configuration-failed" }],
    });
    expect(JSON.stringify(result)).not.toContain("upstream secret response");
    expect(session.status("owner").state).toBe("saved");
    expect(parseToml(readFileSync(fixture.configPath, "utf8")).feishu)
      .toMatchObject({ app_secret: appSecret });
  });
});

function manualSession(environment: NodeJS.ProcessEnv) {
  return createFeishuSetupSession({ ownerId: "owner" }, {
    environment,
    validateApplication: async () => ({
      openId: "ou_bot",
      name: "Manual Bot",
    }),
  });
}

function createFixture(feishu?: TomlTable) {
  const root = mkdtempSync(join(tmpdir(), "codex-connect-feishu-session-"));
  temporaryDirectories.push(root);
  const home = join(root, ".codex-connect");
  const workspace = join(root, "Workspace");
  mkdirSync(workspace);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  initializeUserData({ environment, cwd: workspace });
  const configPath = join(home, "config.toml");
  if (feishu) {
    const document = readGatewayConfig(configPath);
    document.feishu = feishu;
    writeGatewayConfig(configPath, document);
  }
  return { environment, configPath };
}
