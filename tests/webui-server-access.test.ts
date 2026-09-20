import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { createWebuiServer, resolveWebuiSettings } from "../scripts/webui-server.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { applyConfiguredTimezone } from "../scripts/webui-server.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "../scripts/config-management.mjs";
import {
  cleanupWebuiTestFixtures,
  createWebuiStaticDir,
  createWebuiTestFixture,
  metricSample,
  recordSample,
  startWebuiTestServer,
  type WebuiTestServer,
  type WebuiTestServerOptions,
} from "./webui-server-test-fixture.js";

const temporaryDirectories: string[] = [];
const servers: WebuiTestServer[] = [];

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

function createStaticDir(content: string) {
  return createWebuiStaticDir(temporaryDirectories, content);
}

describe("webui server access and settings resolution", () => {
  it("authenticates the health endpoint when WebUI exposes a token", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { token: "webui-token" },
    );

    const unauthorized = await fetch(`${origin}/api/v1/health`);
    expect(unauthorized.status).toBe(401);
    expect((await fetch(`${origin}/api/v1/time`)).status).toBe(401);
    const authorized = await fetch(`${origin}/api/v1/health`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ ok: true, service: "webui" });
  });

  it("serves the static page and rejects unknown paths", async () => {
    const fixture = createFixture();
    const staticDir = createStaticDir("<h1>Codex WebUI</h1>");
    const { origin } = await startServer(fixture.environment, staticDir);

    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Codex WebUI");

    const missing = await fetch(`${origin}/missing.js`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("requires the access token for API requests when configured", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, metricSample());
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { token: "secret-token" },
    );

    const missing = await fetch(`${origin}/api/v1/overview`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error: { code: "unauthorized" },
    });

    const wrong = await fetch(`${origin}/api/v1/overview`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${origin}/api/v1/overview`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(ok.status).toBe(200);
  });

  it("rejects non-loopback hosts without a token", () => {
    const fixture = createFixture();
    expect(() => createWebuiServer({
      environment: fixture.environment,
      host: "0.0.0.0",
    })).toThrow("必须提供访问令牌");
  });

  it("resolves default webui settings without a config file", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-webui-settings-"));
    temporaryDirectories.push(home);
    const settings = resolveWebuiSettings({
      environment: {
        ...process.env,
        CODEX_CONNECT_HOME: home,
        CODEX_CONNECT_CONFIG_FILE: "",
      },
    });
    expect(settings).toMatchObject({ host: "127.0.0.1", port: 8787, token: null });
  });

  it("reads webui settings from config and lets CLI args override", () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}\n`
        + "[webui]\n"
        + 'host = "0.0.0.0"\n'
        + "port = 9000\n"
        + 'token = "cfg-token"\n',
    );

    expect(resolveWebuiSettings({ environment: fixture.environment })).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      token: "cfg-token",
    });

    expect(resolveWebuiSettings({
      environment: fixture.environment,
      args: ["--host", "127.0.0.1", "--port", "8788"],
    })).toMatchObject({
      host: "127.0.0.1",
      port: 8788,
      token: "cfg-token",
    });
  });

  it("rejects non-loopback webui config without a token", () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}\n`
        + "[webui]\n"
        + 'host = "0.0.0.0"\n',
    );

    expect(() => resolveWebuiSettings({ environment: fixture.environment }))
      .toThrow(/绑定非回环地址时必须设置 token/u);
  });

  it("lets the WebUI process follow the configured model-visible timezone", () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const environment: NodeJS.ProcessEnv = {
      ...fixture.environment,
      TZ: "Asia/Shanghai",
    };

    applyConfiguredTimezone(environment, join(fixture.home, "absent.toml"));
    expect(environment.TZ).toBe("Asia/Shanghai");

    applyConfiguredTimezone(environment, configPath);
    expect(environment.TZ).toBe("Asia/Shanghai");

    const settings = loadGatewaySettings(fixture.environment);
    updateGatewaySetting({
      kind: "system.app-server-timezone",
      value: "America/Los_Angeles",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });

    applyConfiguredTimezone(environment, configPath);
    expect(environment.TZ).toBe("America/Los_Angeles");
  });

  it("still applies the token when configured", () => {
    const fixture = createFixture();
    expect(() => createWebuiServer({
      environment: fixture.environment,
      token: "secret-token",
    })).not.toThrow();
  });

  it("allows non-loopback hosts when a token is configured", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, metricSample());
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { host: "0.0.0.0", token: "secret-token" },
    );
    const response = await fetch(`${origin}/api/v1/threads`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(response.status).toBe(200);
  });

  it("allows the loopback management path through an SSH tunnel when bound publicly", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { host: "0.0.0.0", token: "secret-token", managementOrigin },
    );
    const response = await fetch(`${origin}/api/v1/management/settings`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("revision");
  });

  it("accepts the localhost loopback Origin for management requests", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { host: "0.0.0.0", token: "secret-token" },
    );
    const { port } = new URL(origin);
    const response = await fetch(`${origin}/api/v1/management/settings`, {
      headers: {
        authorization: "Bearer secret-token",
        origin: `http://localhost:${port}`,
      },
    });
    expect(response.status).toBe(200);
    const settings = await response.json() as { revision: string };
    expect(settings).toHaveProperty("revision");
    const preview = await fetch(`${origin}/api/v1/management/settings/preview`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        origin: `http://localhost:${port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: settings.revision,
        setting: { kind: "display.reasoning", value: false },
      }),
    });
    expect(preview.status).toBe(200);
  });

  it("accepts a different local loopback port used by an SSH tunnel", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { host: "0.0.0.0", token: "secret-token" },
    );
    const { port } = new URL(origin);
    const response = await fetch(`${origin}/api/v1/management/settings`, {
      headers: {
        authorization: "Bearer secret-token",
        origin: `http://127.0.0.1:${Number(port) + 1}`,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("revision");
  });

  it("rejects an https localhost Origin for management requests", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { host: "0.0.0.0", token: "secret-token" },
    );
    const { port } = new URL(origin);
    const response = await fetch(`${origin}/api/v1/management/settings`, {
      headers: {
        authorization: "Bearer secret-token",
        origin: `https://localhost:${port}`,
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "management.origin-invalid" },
    });
  });
});
