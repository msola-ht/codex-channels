import {
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as filesystem from "node:fs/promises";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readPrivateConfigFile, readPrivateFileSync } from "../runtime/private-file.mjs";
import * as executable from "../runtime/executable.mjs";
import { secureTestDirectory, secureTestFile } from "./support/windows-fixtures.js";

vi.mock("node:fs/promises", { spy: true });
vi.mock("node:child_process", { spy: true });

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codexc-private-file-"));
  directories.push(directory);
  secureTestDirectory(directory);
  const path = join(directory, "config.toml");
  secureTestFile(path, "private-content");
  return { directory, path };
}

describe("private file", () => {
  it("reads a private regular file without following a symbolic link", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-private-file-"));
    directories.push(directory);
    const target = join(directory, "target.txt");
    const link = join(directory, "link.txt");
    secureTestDirectory(directory);
    secureTestFile(target, "secret");
    symlinkSync(target, link);

    expect(readPrivateFileSync(target, 32)).toBe("secret");
    expect(() => readPrivateFileSync(link)).toThrow();
  });

  it("reads current private configuration and refuses oversized files and symbolic links", async () => {
    const { directory, path } = fixture();
    expect(await readPrivateConfigFile(path)).toBe("private-content");
    const link = join(directory, "link.toml");
    symlinkSync(path, link);
    await expect(readPrivateConfigFile(link)).rejects.toThrow();
    writeFileSync(path, "x".repeat(1_048_577));
    await expect(readPrivateConfigFile(path)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects a real FIFO without blocking the configuration read", () => {
    const { path } = fixture();
    rmSync(path);
    execFileSync("mkfifo", ["-m", "600", path], { timeout: 2000 });
    // Isolate the read so a regression cannot strand this worker's filesystem thread pool.
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { readPrivateConfigFile } from ${JSON.stringify(new URL("../runtime/private-file.mjs", import.meta.url).href)};
      await assert.rejects(readPrivateConfigFile(process.env.FIFO_CONFIG_PATH), /权限、类型或大小无效/);
    `], { env: { ...process.env, FIFO_CONFIG_PATH: path }, timeout: 2000, killSignal: "SIGKILL" });
  });

  it.skipIf(process.platform === "win32")("discards a file replaced during an asynchronous read", async () => {
    const { directory, path } = fixture();
    const actualOpen = filesystem.open;
    vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args) => {
      const file = await actualOpen(...args);
      const originalRead = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementationOnce(async (...readArgs: Parameters<typeof file.read>) => {
        const result = await originalRead(...readArgs);
        const replacement = join(directory, "replacement.toml");
        secureTestFile(replacement, "replacement");
        renameSync(replacement, path);
        return result;
      });
      return file;
    });
    await expect(readPrivateConfigFile(path)).rejects.toThrow("读取期间发生变化");
    expect(await readPrivateConfigFile(path)).toBe("replacement");
  });

  it.each(["read", "timeout", "cancel", "invalid", "overflow", "unavailable"])("bounds asynchronous Windows config %s operations without synchronous child processes", async scenario => {
    vi.clearAllMocks();
    const body = `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", data => input += data);
      process.stdin.on("end", () => {
        const request = JSON.parse(input);
        if (request.operation !== "read-config" || request.kind !== "file" || request.path !== "fixture.toml") process.exit(1);
        const scenario = ${JSON.stringify(scenario)};
        if (scenario === "timeout" || scenario === "cancel") setInterval(() => {}, 1000);
        else if (scenario === "overflow") process.stdout.write("x".repeat(8 * 1_048_576 + 1));
        else process.stdout.write(JSON.stringify(scenario === "invalid" ? { ok: false, content: "secret-response" } : { ok: true, content: "private-content" }));
      });`;
    const resolve = vi.spyOn(executable, "resolveExecutableInvocation").mockReturnValue({ file: process.execPath, args: ["-e", body], windowsVerbatimArguments: false });
    if (scenario === "unavailable") resolve.mockImplementation(() => { throw new Error("pwsh missing"); });
    const asynchronous = vi.spyOn(childProcess, "execFile");
    const synchronous = vi.spyOn(childProcess, "spawnSync");
    const controller = new AbortController();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let pending: Promise<string>;
    try {
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      pending = readPrivateConfigFile("fixture.toml", { signal: controller.signal });
    } finally { Object.defineProperty(process, "platform", platform); }
    if (scenario === "unavailable") {
      await expect(pending!).rejects.toThrow("需要 PowerShell 7");
      expect(asynchronous).not.toHaveBeenCalled();
      expect(synchronous).not.toHaveBeenCalled();
      return;
    }
    const child = asynchronous.mock.results[0]!.value as childProcess.ChildProcess;
    const closed = new Promise<void>(accept => child.once("close", () => accept()));
    if (scenario === "cancel") controller.abort();
    if (scenario === "read") expect(await pending!).toBe("private-content");
    else await expect(pending!).rejects.toThrow(scenario === "invalid" ? "读取结果无效" : "读取失败");
    await closed;
    expect(resolve).toHaveBeenCalledOnce();
    expect(asynchronous).toHaveBeenCalledOnce();
    expect(synchronous).not.toHaveBeenCalled();
    if (scenario === "timeout" || scenario === "cancel") {
      expect(child.killed).toBe(true);
      if (platform.value !== "win32") expect(child.signalCode).toBe("SIGKILL");
    }
  });

  it.skipIf(process.platform !== "win32")("checks actual Windows file and parent ACLs without repairing either", async () => {
    const { directory, path } = fixture();
    const acl = (target: string, broaden: boolean) => execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference = 'Stop'
      $item = Get-Item -LiteralPath $env:FIXTURE_PATH -Force
      $sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group -bor [System.Security.AccessControl.AccessControlSections]::Access
      $security = [System.IO.FileSystemAclExtensions]::GetAccessControl($item, $sections)
      if ($env:FIXTURE_BROADEN -eq 'true') {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
          [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
          [System.Security.AccessControl.FileSystemRights]::Modify,
          [System.Security.AccessControl.AccessControlType]::Allow)
        [void]$security.AddAccessRule($rule)
        [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
      }
      $security.GetSecurityDescriptorSddlForm($sections)
    `], { encoding: "utf8", env: { ...process.env, FIXTURE_PATH: target, FIXTURE_BROADEN: String(broaden) }, timeout: 5000 }).trim();
    expect(await readPrivateConfigFile(path)).toBe("private-content");
    const fileAcl = acl(path, true);
    await expect(readPrivateConfigFile(path)).rejects.toThrow();
    expect(acl(path, false)).toBe(fileAcl);
    secureTestFile(path, "private-content");
    const parentAcl = acl(directory, true);
    await expect(readPrivateConfigFile(path)).rejects.toThrow();
    expect(acl(directory, false)).toBe(parentAcl);
    secureTestDirectory(directory);
    expect(await readPrivateConfigFile(path)).toBe("private-content");
  });
});
