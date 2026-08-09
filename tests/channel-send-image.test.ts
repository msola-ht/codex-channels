import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { submitChannelImage } from "../scripts/channel-send-image.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";
import { SqliteBindingStore } from "../src/storage/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "channel-send-image-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const imagePath = join(root, "screenshot.png");
  writeFileSync(imagePath, "fake-png-bytes");
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  initializeUserData({ environment });
  const stateDatabasePath = join(home, "data", "gateway.sqlite3");
  const bindings = new SqliteBindingStore(stateDatabasePath);
  bindings.bind({
    target: {
      surface: "feishu",
      accountId: "cli_app",
      conversationId: "oc_chat",
    },
    workspaceId: "codex-channels",
    threadId: "thread-1",
    sessionId: "thread-1",
  });
  bindings.close();
  return { root, home, environment, imagePath, stateDatabasePath };
}

describe("channel send-image script", () => {
  it("copies the image into the spool and writes a manifest for the target thread", async () => {
    const fixtureData = fixture();

    const result = await submitChannelImage({
      environment: fixtureData.environment,
      imagePath: fixtureData.imagePath,
      threadId: "thread-1",
      stateDatabasePath: fixtureData.stateDatabasePath,
    });

    expect(result).toMatchObject({
      threadId: "thread-1",
      target: {
        surface: "feishu",
        accountId: "cli_app",
        conversationId: "oc_chat",
      },
    });
    const pending = join(fixtureData.stateDatabasePath, "..", "channel-outbox", "pending");
    expect(readdirSync(pending).sort()).toEqual([
      expect.stringMatching(/^[0-9a-f-]+\.json$/u),
      expect.stringMatching(/^[0-9a-f-]+\.png$/u),
    ]);
    const manifestPath = join(pending, readdirSync(pending).find((name) => name.endsWith(".json"))!);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: number;
      threadId: string;
      imagePath: string;
    };
    expect(manifest).toMatchObject({
      version: 1,
      threadId: "thread-1",
    });
    expect(manifest.imagePath.startsWith(pending)).toBe(true);
    expect(readFileSync(manifest.imagePath, "utf8")).toBe("fake-png-bytes");
  });

  it("auto-resolves the only binding when no thread is given", async () => {
    const fixtureData = fixture();

    const result = await submitChannelImage({
      environment: fixtureData.environment,
      imagePath: fixtureData.imagePath,
      stateDatabasePath: fixtureData.stateDatabasePath,
    });

    expect(result.threadId).toBe("thread-1");
  });

  it("requires an explicit thread when multiple bindings exist", async () => {
    const fixtureData = fixture();
    const bindings = new SqliteBindingStore(fixtureData.stateDatabasePath);
    bindings.bind({
      target: {
        surface: "telegram",
        accountId: "default",
        conversationId: "12345",
      },
      workspaceId: "codex-channels",
      threadId: "thread-2",
      sessionId: "thread-2",
    });
    bindings.close();

    await expect(submitChannelImage({
      environment: fixtureData.environment,
      imagePath: fixtureData.imagePath,
      stateDatabasePath: fixtureData.stateDatabasePath,
    })).rejects.toThrow(/--thread/u);
  });

  it("rejects a missing image before touching the spool", async () => {
    const fixtureData = fixture();

    await expect(submitChannelImage({
      environment: fixtureData.environment,
      imagePath: join(fixtureData.root, "missing.png"),
      stateDatabasePath: fixtureData.stateDatabasePath,
    })).rejects.toThrow(/图片文件不存在/u);
  });
});
