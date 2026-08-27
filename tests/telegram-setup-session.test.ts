import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  TelegramSetupSessionError,
  createTelegramSetupSession,
} from "../scripts/telegram-setup-session.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const token = "123456:abcdefghijklmnopqrstuvwxyzABCDE";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Telegram Setup session", () => {
  it("reuses a configured token internally without returning it", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.telegram = {
      bot_token: token,
      allowed_user_ids: [123, 456],
      message_format: "html",
    };
    writeGatewayConfig(fixture.configPath, document);
    const session = createTelegramSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      createClient: (receivedToken: string) => {
        expect(receivedToken).toBe(token);
        return {
          getMe: async () => ({ username: "configured_bot" }),
          getUpdates: async () => [],
        };
      },
    });

    session.start("owner", { source: "configured" });
    const status = await session.waitForValidation("owner");

    expect(status.bot).toEqual({
      username: "configured_bot",
      source: "configured",
      reusesConfiguredBot: true,
      configuredAllowedUserIds: ["123", "456"],
    });
    expect(JSON.stringify(status)).not.toContain(token);
    session.cancel("owner");
  });

  it("keeps the token private, enforces ownership and saves only after confirmation", async () => {
    const fixture = createFixture();
    const writeConfig = vi.fn(writeGatewayConfig);
    const session = createTelegramSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      createSessionId: () => "telegram-session",
      createClient: () => ({
        getMe: async () => ({ username: "private_bot" }),
        getUpdates: async () => [],
      }),
      writeConfig,
    });

    session.start("owner", { source: "existing", token });
    const validated = await session.waitForValidation("owner");

    expect(validated).toMatchObject({
      sessionId: "telegram-session",
      state: "validated",
      bot: {
        username: "private_bot",
        source: "existing",
        reusesConfiguredBot: false,
      },
    });
    expect(JSON.stringify(validated)).not.toContain(token);
    expect(() => session.status("other")).toThrowError(
      expect.objectContaining({ code: "owner-mismatch" }),
    );
    session.useAllowedUserIds("owner", ["123", 456, "123"]);
    expect(session.status("owner").preview).toEqual({
      botUsername: "private_bot",
      allowedUserIds: ["123", "456"],
    });
    expect(writeConfig).not.toHaveBeenCalled();

    const result = await session.confirm("owner");

    expect(result).toEqual({
      action: "configured",
      botUsername: "private_bot",
      allowedUserIds: ["123", "456"],
      configPath: fixture.configPath,
      activation: "restart-gateway",
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(parseToml(readFileSync(fixture.configPath, "utf8")).telegram)
      .toMatchObject({
        bot_token: token,
        allowed_user_ids: [123, 456],
      });
  });

  it("publishes pairing progress and accepts the detected sender", async () => {
    const fixture = createFixture();
    const signals: AbortSignal[] = [];
    let updates = 0;
    const session = createTelegramSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      createPairingCode: () => "pairing-code",
      createClient: () => ({
        getMe: async (signal?: AbortSignal) => {
          if (signal) signals.push(signal);
          return { username: "pairing_bot" };
        },
        getUpdates: async (_parameters: object, signal?: AbortSignal) => {
          if (signal) signals.push(signal);
          updates += 1;
          return updates === 1
            ? []
            : [{
                update_id: 1,
                message: {
                  text: "/start pairing-code",
                  chat: { type: "private" },
                  from: { id: 789, username: "owner" },
                },
              }];
        },
      }),
    });
    const states: string[] = [];
    session.subscribe("owner", (status) => states.push(status.state));

    session.start("owner", { source: "new", token });
    await session.waitForValidation("owner");
    session.startPairing("owner", { waitSeconds: 1 });
    const paired = await session.waitForPairing("owner");

    expect(paired).toMatchObject({
      state: "sender-detected",
      pairing: {
        link: "https://t.me/pairing_bot?start=pairing-code",
        sender: { id: "789", username: "owner", displayName: "" },
      },
    });
    expect(states).toEqual(expect.arrayContaining([
      "validating",
      "validated",
      "preparing-pairing",
      "waiting-for-message",
      "sender-detected",
    ]));
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(1);

    session.acceptPairing("owner", { additionalUserIds: ["987"] });
    expect(session.status("owner").preview?.allowedUserIds)
      .toEqual(["789", "987"]);
    session.cancel("owner");
  });

  it("aborts an in-flight long poll when cancelled", async () => {
    const fixture = createFixture();
    let updateCalls = 0;
    let pollingStarted!: () => void;
    const started = new Promise<void>((resolve) => { pollingStarted = resolve; });
    const session = createTelegramSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      createPairingCode: () => "pairing-code",
      createClient: () => ({
        getMe: async () => ({ username: "cancel_bot" }),
        getUpdates: async (_parameters: object, signal?: AbortSignal) => {
          updateCalls += 1;
          if (updateCalls === 1) return [];
          pollingStarted();
          return await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      }),
    });

    session.start("owner", { source: "new", token });
    await session.waitForValidation("owner");
    session.startPairing("owner");
    const pairing = session.waitForPairing("owner");
    await started;
    session.cancel("owner");

    await pairing;
    expect(session.status("owner")).toMatchObject({ state: "cancelled" });
  });

  it("expires validation and aborts its request", async () => {
    const fixture = createFixture();
    let receivedSignal: AbortSignal | undefined;
    const session = createTelegramSetupSession({
      ownerId: "owner",
      timeoutMs: 10,
    }, {
      environment: fixture.environment,
      createClient: () => ({
        getMe: async (signal?: AbortSignal) => {
          receivedSignal = signal;
          return await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        getUpdates: async () => [],
      }),
    });

    session.start("owner", { source: "new", token });
    await session.waitForValidation("owner");

    expect(receivedSignal?.aborted).toBe(true);
    expect(session.status("owner").state).toBe("expired");
  });

  it("redacts validation errors and rejects stale saves", async () => {
    const failedFixture = createFixture();
    const failed = createTelegramSetupSession({ ownerId: "owner" }, {
      environment: failedFixture.environment,
      createClient: () => ({
        getMe: async () => {
          throw new Error(`request failed: ${token}`);
        },
        getUpdates: async () => [],
      }),
    });
    failed.start("owner", { source: "existing", token });

    await expect(failed.waitForValidation("owner")).rejects.toSatisfy(
      (error: unknown) => error instanceof TelegramSetupSessionError
        && error.code === "validation-failed"
        && error.message.includes("[REDACTED]")
        && !error.message.includes(token),
    );
    expect(JSON.stringify(failed.status("owner"))).not.toContain(token);

    const staleFixture = createFixture();
    const stale = createTelegramSetupSession({ ownerId: "owner" }, {
      environment: staleFixture.environment,
      createClient: () => ({
        getMe: async () => ({ username: "stale_bot" }),
        getUpdates: async () => [],
      }),
    });
    stale.start("owner", { source: "new", token });
    await stale.waitForValidation("owner");
    stale.useAllowedUserIds("owner", ["123"]);
    const document = readGatewayConfig(staleFixture.configPath);
    document.telegram = { proxy_url: "http://127.0.0.1:8080" };
    writeGatewayConfig(staleFixture.configPath, document);

    await expect(stale.confirm("owner")).rejects.toThrowError(
      expect.objectContaining({ code: "stale-session" }),
    );
    expect(stale.status("owner").state).toBe("ready");
    stale.cancel("owner");
  });

  it("fails closed when saving fails", async () => {
    const fixture = createFixture();
    const before = readFileSync(fixture.configPath, "utf8");
    const session = createTelegramSetupSession({ ownerId: "owner" }, {
      environment: fixture.environment,
      createClient: () => ({
        getMe: async () => ({ username: "save_bot" }),
        getUpdates: async () => [],
      }),
      writeConfig: () => { throw new Error("disk unavailable"); },
    });
    session.start("owner", { source: "new", token });
    await session.waitForValidation("owner");
    session.useAllowedUserIds("owner", ["123"]);

    await expect(session.confirm("owner")).rejects.toThrow("disk unavailable");
    expect(session.status("owner")).toMatchObject({
      state: "failed",
      error: { code: "save-failed" },
    });
    expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-connect-telegram-session-"));
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
  return {
    environment,
    configPath: join(home, "config.toml"),
  };
}
