import { once } from "node:events";

import { expect, it } from "vitest";

import { WindowsProxyTransport } from "../src/codex-client/index.js";

const windowsIt = process.platform === "win32" ? it : it.skip;

windowsIt("times out and terminates a silent Codex proxy process", async () => {
  let terminated = false;
  const transport = new WindowsProxyTransport("C:\\codex\\app-server.sock", {
    codexBinary: process.execPath,
    connectTimeoutMs: 50,
    createCodexProcessInvocation: () => ({
      file: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      windowsVerbatimArguments: false,
    }),
    terminateCodexProcess: async (child) => {
      terminated = true;
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    },
  });

  await expect(transport.connect()).rejects.toThrow(
    "连接 Codex Windows Proxy 超时：50ms",
  );
  expect(terminated).toBe(true);
  await transport.close();
});
