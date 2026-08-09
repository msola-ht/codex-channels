import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppServerSupervisorOwner,
  appServerSupervisorSocketPath,
} from "../runtime/app-server-supervisor.mjs";

const temporaryDirectories: string[] = [];
const unixSocketTmpdir = process.platform === "darwin" ? "/tmp" : tmpdir();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("App Server supervisor", () => {
  it("closes promptly while a local client keeps its connection open", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-close-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      socketPaths: [primarySocketPath],
    });
    await owner.start();
    const client = createConnection(appServerSupervisorSocketPath(primarySocketPath));
    client.on("error", () => undefined);
    client.pause();
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client.once("connect", resolveConnect);
      client.once("error", rejectConnect);
    });

    const closed = await Promise.race([
      owner.close().then(() => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 250)),
    ]);

    client.destroy();
    expect(closed).toBe(true);
    expect(existsSync(appServerSupervisorSocketPath(primarySocketPath))).toBe(false);
  });
});
