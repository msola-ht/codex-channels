import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  spawnMacDesktopHostedCodex,
  validateMacDesktopAppAttachment,
  type MacDesktopAppAttachment,
} from "../runtime/desktop-app-host.mjs";
import { signalChildProcesses, terminateChildProcess } from "../runtime/process-lifecycle.mjs";

vi.mock("node:child_process", { spy: true });

const children: ChildProcess[] = [];
const directories: string[] = [];
const codexVersion = JSON.parse(readFileSync(new URL("../src/codex-protocol/version.json", import.meta.url), "utf8")).codexCli;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(children.splice(0).map(child => terminateChildProcess(child, { gracePeriodMs: 50 })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("Desktop signed Host process ownership", () => {
  it("preserves native normal exit and failed startup", async () => {
    const normal = startHost(["-e", "process.exit(7)"]);
    await expect(once(normal, "exit")).resolves.toEqual([7, null]);
    const signaled = startHost(["-e", "process.kill(process.pid, 'SIGTERM')"]);
    await expect(once(signaled, "exit")).resolves.toEqual([null, "SIGTERM"]);
    const missing = startHost([], { nativeCodexPath: "/missing-desktop-native-codex" });
    await expect(once(missing, "exit")).resolves.toEqual([1, null]);
  });

  it("signals the owned native child once and reaps it before Host exit", async () => {
    const host = startHost(["-e", `
      let signals = 0;
      process.on("SIGTERM", () => {
        signals++;
        setTimeout(() => { console.log(signals); process.exit(0); }, 40);
      });
      console.log(process.pid);
      setInterval(() => {}, 1000);
    `]);
    let output = "";
    host.stdout!.on("data", data => { output += data.toString(); });
    await vi.waitFor(() => expect(output).toMatch(/^\d+\n/u));
    const nativePid = Number(output.trim());
    const exited = once(host, "exit");
    signalChildProcesses([host], "SIGTERM");
    await exited;
    expect(output.trim().split("\n")[1]).toBe("1");
    expect(processExists(nativePid)).toBe(false);
  });

  it("terminates a stuck native child with its Host without signaling an unrelated child", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(unrelated);
    const host = startHost(["-e", `
      process.on("SIGTERM", () => {});
      console.log(process.pid);
      setInterval(() => {}, 1000);
    `]);
    let output = "";
    host.stdout!.on("data", data => { output += data.toString(); });
    await vi.waitFor(() => expect(output).toMatch(/^\d+\n/u));
    const nativePid = Number(output.trim());
    await terminateChildProcess(host, { gracePeriodMs: 100, forcePeriodMs: 1_000 });
    expect(host.signalCode).toBe("SIGKILL");
    await vi.waitFor(() => expect(processIsAlive(nativePid)).toBe(false));
    expect(processExists(unrelated.pid!)).toBe(true);
    expect(unrelated.exitCode).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("Desktop signed executable validation", () => {
  it.each(["invalid", "timeout", "identity"])("rejects %s signatures before executing native Codex", async scenario => {
    const fixture = await signedFixture();
    const mockedSpawn = vi.mocked(spawnSync);
    mockedSpawn.mockImplementation(((_command: string, args: string[]) => {
      if (args.includes("--verify")) return scenario === "invalid"
        ? { status: 1, stderr: "sensitive codesign failure" }
        : scenario === "timeout"
          ? { status: null, error: Object.assign(new Error("sensitive timeout"), { code: "ETIMEDOUT" }) }
          : { status: 0 };
      return { status: 0, stdout: "", stderr: "Identifier=node\nTeamIdentifier=OTHER" };
    }) as unknown as typeof spawnSync);
    try {
      expect(() => validateMacDesktopAppAttachment(fixture.options)).toThrow(scenario === "identity" ? "签名不匹配：node" : "签名验证失败：node");
      expect(mockedSpawn.mock.calls.some(([command]) => command === fixture.options.codexBinary)).toBe(false);
    } finally { await fixture.close(); }
  });

  it("verifies disk signatures against the Apple anchor, exact identifier and OpenAI Team", async () => {
    const fixture = await signedFixture();
    vi.mocked(spawnSync).mockImplementation(((_command: string, args: string[]) => {
      if (args.includes("--verify")) return { status: 0 };
      if (args.includes("--version")) return { status: 0, stdout: codexVersion };
      const identifier = args.at(-1) === fixture.options.codexBinary ? "codex" : "node";
      return { status: 0, stdout: "", stderr: `Identifier=${identifier}\nTeamIdentifier=2DC432GLL2` };
    }) as unknown as typeof spawnSync);
    try {
      expect(validateMacDesktopAppAttachment(fixture.options).nativeCodexPath).toBe(fixture.options.codexBinary);
      for (const identifier of ["node", "codex"]) {
        expect(spawnSync).toHaveBeenCalledWith("/usr/bin/codesign", [
          "--verify", "--strict",
          `-R=anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "2DC432GLL2"`,
          identifier === "node" ? fixture.nodePath : fixture.options.codexBinary,
        ], expect.objectContaining({ timeout: 5_000, killSignal: "SIGKILL" }));
      }
    } finally { await fixture.close(); }
  });
});

function startHost(args: string[], overrides: Partial<MacDesktopAppAttachment> = {}) {
  const host = spawnMacDesktopHostedCodex({
    key: "fixture", appPath: "/fixture/ChatGPT.app", pipePath: "/fixture/tools.sock",
    toolsEnabled: true, resourcesPath: "/fixture/resources", nodePath: process.execPath,
    nativeCodexPath: process.execPath, ...overrides,
  }, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(host);
  return host;
}

function processExists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function processIsAlive(pid: number) {
  if (!processExists(pid)) return false;
  // Minimal Linux containers may retain exited orphan zombies until PID 1 reaps.
  if (process.platform === "linux") {
    try { return !readFileSync(`/proc/${pid}/stat`, "utf8").match(/^\d+ \(.*\) Z /u); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function signedFixture() {
  const directory = realpathSync(mkdtempSync("/tmp/cdsh-"));
  directories.push(directory);
  const appPath = join(directory, "ChatGPT.app");
  const nodePath = join(appPath, "Contents", "Resources", "cua_node", "bin", "node");
  mkdirSync(join(nodePath, ".."), { recursive: true });
  writeFileSync(nodePath, "fixture", { mode: 0o700 });
  const codexBinary = join(directory, "codex");
  writeFileSync(codexBinary, "fixture", { mode: 0o700 });
  const pipePath = join(directory, "tools.sock");
  const server = createServer();
  await new Promise<void>(resolve => server.listen(pipePath, resolve));
  chmodSync(pipePath, 0o600);
  vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
  return { nodePath, options: { appPath, codexBinary, pipePath, toolsEnabled: true },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
