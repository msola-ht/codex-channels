import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseTrafficCleanupArgs,
  parseTrafficCommandArgs,
  TRAFFIC_CLEANUP_USAGE,
  TRAFFIC_USAGE,
} from "../scripts/traffic-command-options.mjs";
import {
  assertConfiguredAppServersStopped,
  runTrafficCleanup,
  trafficCleanupPreview,
} from "../scripts/traffic-cleanup.mjs";

const trafficScript = resolve("scripts/traffic-command.mjs");
const temporaryDirectories: string[] = [];
const runningChildren = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of runningChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
  }
  runningChildren.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("traffic command options", () => {
  it("defaults to listing the newest V2 session", () => {
    expect(parseTrafficCommandArgs([])).toEqual({
      all: false,
      directory: undefined,
      exchange: undefined,
      files: [],
      follow: false,
      grep: undefined,
      list: false,
      maxBytes: undefined,
    });
  });

  it("parses filters and session paths", () => {
    expect(parseTrafficCommandArgs([
      "--exchange", "12", "--max-bytes", "0", "--grep", "deepseek",
      "--dir", "relative-traffic", "relative-session",
    ])).toEqual({
      all: false,
      directory: resolve("relative-traffic"),
      exchange: 12,
      files: [resolve("relative-session")],
      follow: false,
      grep: "deepseek",
      list: false,
      maxBytes: 0,
    });
  });

  it.each([
    [["--bogus"], "未知参数：--bogus"],
    [["--exchange"], "--exchange 缺少值"],
    [["--exchange", "0"], "--exchange 需要正整数值"],
    [["--max-bytes", "-1"], "--max-bytes 需要非负整数值"],
    [["--grep", "--all"], "--grep 缺少值"],
    [["--list", "--all"], "--list 与 --all 不能同时使用"],
  ] as const)("rejects %j", (args, message) => {
    expect(() => parseTrafficCommandArgs([...args])).toThrow(message);
  });

  it("documents every public option and the V2 session boundary", () => {
    for (const option of ["--list", "--all", "--exchange", "--grep", "--max-bytes", "--follow", "--dir", "--help"]) {
      expect(TRAFFIC_USAGE).toContain(option);
    }
    expect(TRAFFIC_USAGE).toContain("V2 session");
    expect(TRAFFIC_USAGE).toContain("旧版逐帧");
  });

  it("parses cleanup preview and confirmation options", () => {
    expect(parseTrafficCleanupArgs([])).toEqual({ confirm: false, directory: undefined });
    expect(parseTrafficCleanupArgs(["--dir", "relative-traffic", "--confirm"])).toEqual({
      confirm: true,
      directory: resolve("relative-traffic"),
    });
    expect(() => parseTrafficCleanupArgs(["--all"])).toThrow("未知清理参数：--all");
    expect(TRAFFIC_CLEANUP_USAGE).toContain("--confirm");
  });
});

describe("traffic cleanup", () => {
  it("previews recognized dumps without deleting them", async () => {
    const directory = temporaryDirectory();
    const session = writeSession(directory, "openai", "2026-09-18T00-00-00-000Z", [interaction(1, "hello")]);
    const legacy = join(directory, "openai-2026-09-17T00-00-00-000Z-1.jsonl");
    const unknown = join(directory, "notes.jsonl");
    writeFileSync(legacy, "{}\n");
    writeFileSync(unknown, "keep\n");
    const lines: string[] = [];

    const preview = await runTrafficCleanup(["--dir", directory], {
      assertAppServersStopped: async () => { throw new Error("不应检查服务"); },
      output: { log: (line) => { lines.push(line); } },
    });

    expect(preview).toMatchObject({ v2Sessions: 1, legacyFiles: 1, labels: 1 });
    expect(lines.join("\n")).toContain("未删除");
    expect(trafficCleanupPreview(directory).targets).toEqual([session, legacy]);
    expect(readFileSync(unknown, "utf8")).toBe("keep\n");
  });

  it("requires stopped App Servers before confirmed deletion", async () => {
    const directory = temporaryDirectory();
    const session = writeSession(directory, "openai", "2026-09-18T00-00-00-000Z", [interaction(1, "hello")]);
    await expect(runTrafficCleanup(["--dir", directory, "--confirm"], {
      assertAppServersStopped: async () => { throw new Error("App Server 仍在运行"); },
      output: { log: () => undefined },
    })).rejects.toThrow("App Server 仍在运行");
    expect(trafficCleanupPreview(directory).targets).toEqual([session]);
  });

  it("deletes recognized dumps after explicit confirmation and leaves unknown files", async () => {
    const directory = temporaryDirectory();
    writeSession(directory, "deepseek", "2026-09-18T00-00-00-000Z", [interaction(1, "hello")]);
    writeFileSync(join(directory, "deepseek-2026-09-17T00-00-00-000Z-1.jsonl"), "{}\n");
    const unknown = join(directory, "keep.jsonl");
    writeFileSync(unknown, "keep\n");
    let checked = 0;

    const result = await runTrafficCleanup(["--dir", directory, "--confirm"], {
      assertAppServersStopped: async () => { checked += 1; },
      output: { log: () => undefined },
    });

    expect(checked).toBe(1);
    expect(result).toMatchObject({ v2Sessions: 1, legacyFiles: 1 });
    expect(trafficCleanupPreview(directory).targets).toEqual([]);
    expect(readFileSync(unknown, "utf8")).toBe("keep\n");
  });

  it("rejects confirmed cleanup outside the current configured traffic directory", async () => {
    const home = temporaryDirectory();
    const other = temporaryDirectory();
    writeFileSync(join(home, "config.toml"), "version = 1\n");

    await expect(assertConfiguredAppServersStopped(
      { CODEX_CONNECT_HOME: home },
      other,
    )).rejects.toThrow(`确认清理只允许当前配置的转储目录：${join(home, "traffic")}`);
  });

  it("rejects confirmed cleanup when no Gateway configuration can be verified", async () => {
    const home = temporaryDirectory();

    await expect(assertConfiguredAppServersStopped(
      { CODEX_CONNECT_HOME: home },
      join(home, "traffic"),
    )).rejects.toThrow("必须先初始化并使用对应的 Gateway 配置");
  });
});

describe("traffic command V2 rendering", () => {
  it("lists logical model calls from the newest label and session", () => {
    const directory = temporaryDirectory();
    writeSession(directory, "openai", "2026-09-17T00-00-00-000Z", [interaction(1, "old")], 100);
    writeSession(directory, "openai", "2026-09-18T00-00-00-000Z", [interaction(1, "new")], 200);
    writeSession(directory, "deepseek", "2026-09-18T01-00-00-000Z", [interaction(1, "latest")], 300);

    const result = runTraffic(["--dir", directory]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 次模型调用");
    expect(result.stdout).toContain("模型=deepseek-flash→deepseek-flash");
    expect(result.stdout).toContain("结果=完成");
  });

  it("renders exactly one request and one terminal response", () => {
    const directory = temporaryDirectory();
    writeSession(directory, "openai", "2026-09-18T00-00-00-000Z", [interaction(1, "hello")]);

    const result = runTraffic(["--dir", directory, "--exchange", "1"]);
    expect(result.status).toBe(0);
    expect(result.stdout.match(/\n请求：/gu)).toHaveLength(1);
    expect(result.stdout.match(/\n响应：/gu)).toHaveLength(1);
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain('"type": "response.completed"');
    expect(result.stdout).toContain("模型对照：名称一致");
    expect(result.stdout).toContain("服务端模型声明：未记录");
    expect(result.stdout).toContain("安全缓冲候选声明：未记录");
    expect(result.stdout).toContain("安全缓冲候选不表示已经切换");
    expect(result.stdout).toContain("本次调用（单调时钟）");
    expect(result.stdout).toContain("未记录阶段，不从历史记录补算");
    expect(result.stdout).toContain("上游轮次统计（独立口径）");
  });

  it("shows the recorded Chat upstream provider and keeps a placeholder when absent", () => {
    const directory = temporaryDirectory();
    writeSession(directory, "clp", "upstream-provider", [interaction(1, "hello", "deepseek"), interaction(2, "plain")]);

    const list = runTraffic(["--dir", directory, "--list"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("上游=deepseek");
    expect(list.stdout).toContain("上游=-");

    const reported = runTraffic(["--dir", directory, "--exchange", "1"]);
    expect(reported.status).toBe(0);
    expect(reported.stdout).toContain("上游提供商：deepseek");

    const absent = runTraffic(["--dir", directory, "--exchange", "2"]);
    expect(absent.status).toBe(0);
    expect(absent.stdout).toContain("上游提供商：未记录");
  });

  it("filters logical calls and bounds payload output", () => {
    const directory = temporaryDirectory();
    writeSession(directory, "openai", "2026-09-18T00-00-00-000Z", [
      interaction(1, "alpha"), interaction(2, "needle-" + "x".repeat(100)),
    ]);

    const filtered = runTraffic(["--dir", directory, "--all", "--grep", "needle"]);
    expect(filtered.stdout).toContain("#2");
    expect(filtered.stdout).not.toContain("#1 ");
    const bounded = runTraffic(["--dir", directory, "--exchange", "2", "--max-bytes", "35"]);
    expect(bounded.stdout).toContain("needle-xxx");
    expect(bounded.stdout).not.toContain("x".repeat(20));
  });

  it("fails clearly for legacy JSONL and missing logical calls", () => {
    const legacyDirectory = temporaryDirectory();
    writeFileSync(join(legacyDirectory, "openai-2026-09-18T00-00-00-000Z-1.jsonl"), "{}\n");
    const legacy = runTraffic(["--dir", legacyDirectory]);
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toContain("旧版逐帧 JSONL");

    const directory = temporaryDirectory();
    writeSession(directory, "openai", "2026-09-18T00-00-00-000Z", [interaction(1, "hello")]);
    const missing = runTraffic(["--dir", directory, "--exchange", "9"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("没有找到模型调用 #9");

    const malformedDirectory = temporaryDirectory();
    const malformedSession = join(malformedDirectory, "openai-broken");
    mkdirSync(malformedSession);
    writeFileSync(join(malformedSession, "manifest.json"), "{broken");
    const malformed = runTraffic(["--dir", malformedDirectory]);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("manifest 无效");
  });

  it("follows logical records in an explicitly selected session", async () => {
    const directory = temporaryDirectory();
    const session = writeSession(
      directory, "openai", "2026-09-18T00-00-00-000Z", [interaction(1, "hello")],
    );
    const child = spawn(process.execPath, [trafficScript, "--follow", session], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningChildren.add(child);
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    await waitFor(() => stdout.includes("#1"), () => stdout);
    child.kill("SIGINT");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    runningChildren.delete(child);
    expect(stdout).toContain("结果=完成");
  });

  it("follows the first session created after startup", async () => {
    const directory = temporaryDirectory();
    const child = spawn(process.execPath, [trafficScript, "--follow", "--dir", directory], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningChildren.add(child);
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    await waitFor(() => stdout.includes("按 Ctrl-C 停止"), () => stdout);
    writeSession(directory, "openai", "2026-09-18T00-00-00-000Z", [interaction(1, "hello")]);
    await waitFor(() => stdout.includes("#1"), () => stdout);
    child.kill("SIGINT");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    runningChildren.delete(child);
  });

  it("applies filters while following an explicit session", async () => {
    const directory = temporaryDirectory();
    const session = writeSession(directory, "openai", "2026-09-18T00-00-00-000Z", [
      interaction(1, "first"), interaction(2, "second"),
    ]);
    const child = spawn(process.execPath, [trafficScript, "--follow", "--grep", "#2", session], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningChildren.add(child);
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    await waitFor(() => stdout.includes("#2"), () => stdout);
    child.kill("SIGINT");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    runningChildren.delete(child);
    expect(stdout).not.toContain("#1 ");
  });

  it("waits for a pending call to receive its terminal response before following it", async () => {
    const directory = temporaryDirectory();
    const session = writeSession(
      directory, "openai", "2026-09-18T00-00-00-000Z", [interaction(1, "pending")],
    );
    const indexPath = join(session, "interactions.jsonl");
    const [requestLine, responseLine] = readFileSync(indexPath, "utf8").trim().split("\n");
    writeFileSync(indexPath, `${requestLine}\n`);
    const child = spawn(process.execPath, [trafficScript, "--follow", session], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningChildren.add(child);
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    await waitFor(() => stdout.includes("按 Ctrl-C 停止"), () => stdout);
    await new Promise((resolveTick) => setTimeout(resolveTick, 1_100));
    appendFileSync(indexPath, `${responseLine}\n`);
    await waitFor(() => stdout.includes("结果=完成"), () => stdout);
    child.kill("SIGINT");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    runningChildren.delete(child);
    expect(stdout.match(/#1 /gu)).toHaveLength(1);
    expect(stdout).not.toContain("结果=进行中");
  });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "codexc-traffic-cli-v2-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runTraffic(args: string[]) {
  return spawnSync(process.execPath, [trafficScript, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

function interaction(id: number, prompt: string, upstreamProvider?: string) {
  return {
    requestBody: JSON.stringify({ input: [prompt], model: "deepseek-flash" }),
    responseBody: JSON.stringify({ response: { model: "deepseek-flash", output: [] }, type: "response.completed" }),
    request: {
      id, kind: "request", method: "POST", path: "/responses", requestKind: "turn",
      requestModel: "deepseek-flash", startedAtMs: 1_700_000_000_000 + id,
      threadId: `thread-${id}`, transport: "http", turnId: `turn-${id}`,
    },
    response: {
      durationMs: 12, id, kind: "response", responseModels: ["deepseek-flash"],
      state: "completed", status: 200,
      ...(upstreamProvider === undefined ? {} : { upstreamProvider }),
    },
  };
}

function writeSession(
  directory: string,
  label: string,
  session: string,
  interactions: ReturnType<typeof interaction>[],
  createdAtMs = 1_700_000_000_000,
) {
  const path = join(directory, `${label}-${session}`);
  mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(path, "manifest.json"), JSON.stringify({ createdAtMs, label, session, version: 2 }));
  const payloads: Buffer[] = [];
  const records: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (const item of interactions) {
    const request = Buffer.from(item.requestBody);
    const requestPayload = { bytes: request.length, parts: [{ bytes: request.length, encoding: "utf8", file: "payload-1.bin", offset }] };
    payloads.push(request);
    offset += request.length;
    const response = Buffer.from(item.responseBody);
    const responsePayload = { bytes: response.length, parts: [{ bytes: response.length, encoding: "utf8", file: "payload-1.bin", offset }] };
    payloads.push(response);
    offset += response.length;
    records.push(
      { version: 2, ...item.request, payload: requestPayload },
      { version: 2, ...item.response, payload: responsePayload },
    );
  }
  writeFileSync(join(path, "payload-1.bin"), Buffer.concat(payloads), { mode: 0o600 });
  writeFileSync(join(path, "interactions.jsonl"), records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
  writeFileSync(join(path, "trace-1.jsonl"), "", { mode: 0o600 });
  return path;
}

async function waitFor(condition: () => boolean, describe: () => string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
  throw new Error(`等待输出超时：\n${describe()}`);
}
