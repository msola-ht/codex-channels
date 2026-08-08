import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";

import {
  ChannelImageSpool,
  type ChannelImageSpoolOptions,
} from "../src/bootstrap/channel-image-spool.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "channel-image-spool-"));
  temporaryDirectories.push(root);
  const pending = join(root, "pending");
  mkdirSync(pending, { recursive: true });
  return { root, pending, done: join(root, "done"), failed: join(root, "failed") };
}

function writeEntry(
  pending: string,
  base: string,
  {
    threadId = "thread-1",
    imagePath = join(pending, `${base}.png`),
  }: { threadId?: string; imagePath?: string } = {},
) {
  writeFileSync(imagePath, "fake-image-bytes");
  writeFileSync(join(pending, `${base}.json`), JSON.stringify({
    version: 1,
    threadId,
    imagePath,
    createdAtMs: 1_000,
  }));
  return imagePath;
}

function spool(
  directory: string,
  overrides: Partial<
    Pick<ChannelImageSpoolOptions, "resolveTarget" | "sendImage">
  > = {},
) {
  const sends: Array<{ conversationId: string; imagePath: string }> = [];
  const instance = new ChannelImageSpool({
    directory,
    resolveTarget: (threadId): ConversationTarget | undefined =>
      threadId === "thread-1"
        ? {
            surface: "feishu",
            accountId: "app",
            conversationId: "oc_chat",
          }
        : undefined,
    sendImage: async (target, imagePath) => {
      sends.push({ conversationId: target.conversationId, imagePath });
    },
    logger: pino({ level: "silent" }),
    pollIntervalMs: 10_000,
    ...overrides,
  });
  return { instance, sends };
}

describe("channel image spool", () => {
  it("sends a pending entry to the bound conversation and archives it", async () => {
    const dir = fixture();
    const imagePath = writeEntry(dir.pending, "entry-1");
    const { instance, sends } = spool(dir.root);

    await instance.start();
    await instance.stop();

    expect(sends).toEqual([{
      conversationId: "oc_chat",
      imagePath,
    }]);
    expect(readdirSync(dir.pending)).toEqual([]);
    expect(readdirSync(dir.done).sort()).toEqual([
      "entry-1.json",
      "entry-1.png",
    ]);
  });

  it("archives to failed when the thread has no binding", async () => {
    const dir = fixture();
    writeEntry(dir.pending, "entry-1", { threadId: "missing-thread" });
    const { instance } = spool(dir.root);

    await instance.start();
    await instance.stop();

    expect(readdirSync(dir.failed).sort()).toEqual([
      "entry-1.error.txt",
      "entry-1.json",
      "entry-1.png",
    ]);
    expect(readFileSync(join(dir.failed, "entry-1.error.txt"), "utf8"))
      .toContain("Thread 未绑定会话");
  });

  it("archives invalid manifests without sending", async () => {
    const dir = fixture();
    writeFileSync(join(dir.pending, "bad.json"), "{not-json");
    writeFileSync(join(dir.pending, "bad.png"), "fake-image-bytes");
    let sent = false;
    const { instance } = spool(dir.root, {
      sendImage: async () => {
        sent = true;
      },
    });

    await instance.start();
    await instance.stop();

    expect(sent).toBe(false);
    expect(readdirSync(dir.failed)).toContain("bad.error.txt");
    expect(readFileSync(join(dir.failed, "bad.error.txt"), "utf8"))
      .toContain("不是有效 JSON");
  });

  it("archives send failures and continues with the next entry", async () => {
    const dir = fixture();
    writeEntry(dir.pending, "entry-1");
    writeEntry(dir.pending, "entry-2");
    const { instance, sends } = spool(dir.root, {
      sendImage: async (target, imagePath) => {
        if (imagePath.endsWith("entry-1.png")) {
          throw new Error("platform rejected");
        }
        sends.push({ conversationId: target.conversationId, imagePath });
      },
    });

    await instance.start();
    await instance.stop();

    expect(sends).toHaveLength(1);
    expect(readdirSync(dir.failed).sort()).toEqual([
      "entry-1.error.txt",
      "entry-1.json",
      "entry-1.png",
    ]);
    expect(readdirSync(dir.done).sort()).toEqual([
      "entry-2.json",
      "entry-2.png",
    ]);
  });

  it("rejects manifests whose image path is outside the pending directory", async () => {
    const dir = fixture();
    writeEntry(dir.pending, "entry-1", {
      imagePath: "/tmp/outside.png",
    });
    const { instance, sends } = spool(dir.root);

    await instance.start();
    await instance.stop();

    expect(sends).toEqual([]);
    expect(readFileSync(join(dir.failed, "entry-1.error.txt"), "utf8"))
      .toContain("pending");
  });

  it("keeps the spool directory after an idle start", async () => {
    const dir = fixture();
    const { instance } = spool(dir.root);

    await instance.start();
    await instance.stop();

    expect(existsSync(join(dir.root, "pending"))).toBe(true);
  });
});
