import { afterAll, describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { StdioTransport } from "../src/codex-client/stdio-transport.js";
import { appendDiagnostic, appServerFailure } from "./support/real-app-server-helpers.js";

const run = process.env.RUN_CODEX_INTEGRATION === "1";
const suite = run ? describe : describe.skip;
suite("real Codex App Server over stdio", () => {
  let client: CodexAppServerClient;

  afterAll(async () => {
    await client?.close();
  });

  it("uses the same client contract to initialize and list threads", async () => {
    const workdir = process.cwd();
    let appServerStderr = "";
    client = new CodexAppServerClient(
      new JsonRpcClient(new StdioTransport({
        codexBinary: "codex",
        cwd: workdir,
        onStderr: (chunk) => {
          appServerStderr = appendDiagnostic(appServerStderr, chunk);
        },
      })),
      { sandbox: "read-only" },
    );

    let initialized;
    let threads;
    try {
      initialized = await client.connect();
      threads = await client.listThreads(workdir);
    } catch (error) {
      throw new Error(
        appServerFailure(
          error instanceof Error ? error.message : String(error),
          appServerStderr,
        ),
        { cause: error },
      );
    }

    const platformNames: Partial<Record<NodeJS.Platform, string>> = {
      darwin: "macos",
      linux: "linux",
      win32: "windows",
    };
    const expectedPlatform = platformNames[process.platform];
    if (expectedPlatform) {
      expect(initialized.platformOs).toBe(expectedPlatform);
    } else {
      expect(initialized.platformOs).not.toBe("");
    }
    expect(Array.isArray(threads)).toBe(true);
  }, 15_000);
});
