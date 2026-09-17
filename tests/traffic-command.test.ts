import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseTrafficCommandArgs,
  TRAFFIC_USAGE,
} from "../scripts/traffic-command-options.mjs";

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
  it("defaults to listing the newest dump files", () => {
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

  it("parses filters, absolute file paths and the dump directory", () => {
    expect(parseTrafficCommandArgs([
      "--exchange", "12",
      "--max-bytes", "0",
      "--grep", "deepseek",
      "--dir", "relative-traffic",
      "relative-dump.jsonl",
      "/absolute-dump.jsonl",
    ])).toEqual({
      all: false,
      directory: resolve("relative-traffic"),
      exchange: 12,
      files: [resolve("relative-dump.jsonl"), "/absolute-dump.jsonl"],
      follow: false,
      grep: "deepseek",
      list: false,
      maxBytes: 0,
    });
    expect(parseTrafficCommandArgs(["--all", "--follow"])).toMatchObject({
      all: true,
      follow: true,
      list: false,
    });
  });

  it.each([
    [["--bogus"], "未知参数：--bogus"],
    [["--exchange"], "--exchange 缺少值"],
    [["--exchange", "abc"], "--exchange 需要正整数值"],
    [["--exchange", "0"], "--exchange 需要正整数值"],
    [["--max-bytes", "-1"], "--max-bytes 需要非负整数值"],
    [["--exchange", "-2"], "--exchange 需要正整数值"],
    [["--max-bytes", "1.5"], "--max-bytes 需要非负整数值"],
    [["--max-bytes", "9007199254740992"], "--max-bytes 需要非负整数值"],
    [["--grep", "--all"], "--grep 缺少值"],
    [["--dir"], "--dir 缺少值"],
    [["--list", "--all"], "--list 与 --all 不能同时使用"],
  ] as const)("rejects %j", (args, message) => {
    expect(() => parseTrafficCommandArgs([...args])).toThrow(message);
  });

  it("documents every option in the shared usage text", () => {
    for (const option of [
      "--list",
      "--all",
      "--exchange",
      "--grep",
      "--max-bytes",
      "--follow",
      "--dir",
      "-h, --help",
    ]) {
      expect(TRAFFIC_USAGE).toContain(option);
    }
  });
});

describe("traffic command rendering", () => {
  it("ignores non-file JSONL directory entries", () => {
    const directory = trafficDirectory();
    writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      httpExchange(1),
    );
    mkdirSync(join(directory, "ignored.jsonl"));

    const result = runTraffic(["--dir", directory]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("#1");
  });

  it("lists exchanges from the newest label and merges rotated files", () => {
    const directory = trafficDirectory();
    writeDumpFile(directory, "ocg-account-2026-09-17T00-00-05-000Z-1.jsonl", 5, httpExchange(1));
    writeDumpFile(directory, "openai-2026-09-17T00-00-00-000Z-1.jsonl", 10, httpExchange(1));
    writeDumpFile(directory, "openai-2026-09-17T00-00-00-000Z-2.jsonl", 20, websocketExchange(2));

    const result = runTraffic(["--dir", directory]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 个 exchange");
    expect(result.stdout).toContain("#1");
    expect(result.stdout).toContain("POST /responses");
    expect(result.stdout).toContain("线程=th-http0");
    expect(result.stdout).toContain("轮次=tu-http0");
    expect(result.stdout).toContain("类型=turn");
    expect(result.stdout).toContain("状态=200");
    expect(result.stdout).toContain("#2");
    expect(result.stdout).toContain("WebSocket wss://chatgpt.com/backend-api/codex/responses");
    expect(result.stdout).toContain("有中断记录");
    expect(result.stdout).not.toContain("ocg-account");
  });

  it("streams complete exchanges when one line in the latest session is malformed", () => {
    const directory = trafficDirectory();
    const first = writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      httpExchange(1),
    );
    appendFileSync(first, "{malformed\n");
    writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-2.jsonl",
      20,
      websocketExchange(2),
    );

    const result = runTraffic(["--all", "--dir", directory]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 个 exchange");
    expect(result.stdout).toContain("#1 ");
    expect(result.stdout).toContain("POST /responses");
    expect(result.stdout).toContain("#2 ");
    expect(result.stdout).toContain("WebSocket wss://chatgpt.com/backend-api/codex/responses");
  });

  it("renders the full HTTP request and response of one exchange", () => {
    const directory = trafficDirectory();
    writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      websocketExchange(1),
      httpExchange(2),
    );

    const result = runTraffic(["--dir", directory, "--exchange", "2"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("#2");
    expect(result.stdout).toContain("账户：acct-openai");
    expect(result.stdout).toContain("线程：th-http0001-full  轮次：tu-http0001-full  类型：turn");
    expect(result.stdout).toContain("模型：请求 deepseek-flash  响应 deepseek-flash");
    expect(result.stdout).toContain("authorization: Bearer <redacted>");
    expect(result.stdout).toContain('"model": "deepseek-flash"');
    expect(result.stdout).toContain("响应状态：200");
    expect(result.stdout).toContain("[response.created]");
    expect(result.stdout).toContain("[response.output_text.delta]");
    expect(result.stdout).not.toContain("wss://chatgpt.com");
  });

  it("renders WebSocket handshake headers, both directions and interruptions", () => {
    const directory = trafficDirectory();
    writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      websocketExchange(1),
    );

    const result = runTraffic(["--dir", directory, "--all"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("握手请求头：");
    expect(result.stdout).toContain("user-agent: codex-cli");
    expect(result.stdout).toContain("模型：请求 gpt-6-astra  响应 gpt-6-astra");
    expect(result.stdout).toContain("→ App Server 发出：");
    expect(result.stdout).toContain("← 上游返回：");
    expect(result.stdout).toContain('"type": "response.created"');
    expect(result.stdout).toContain("连接关闭：client code=1006 原因=client_disconnected");
    expect(result.stdout).toContain("中断：client_disconnected 连接被客户端关闭");
  });

  it("joins split bodies and split websocket frames", () => {
    const directory = trafficDirectory();
    writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      splitWebsocketExchange(1),
    );

    const result = runTraffic(["--dir", directory, "--exchange", "1", "--max-bytes", "10000"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"type": "response.create"');
    expect(result.stdout).toContain('"model": "gpt-6-astra"');
    expect(result.stdout).not.toContain("…（本段共");
  });

  it("filters by keyword and truncates long payloads", () => {
    const directory = trafficDirectory();
    writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      httpExchange(1),
      websocketExchange(2),
    );

    const filtered = runTraffic(["--dir", directory, "--all", "--grep", "gpt-6-astra"]);
    expect(filtered.stdout).toContain("#2");
    expect(filtered.stdout).not.toContain("#1");

    const truncated = runTraffic(["--dir", directory, "--exchange", "1", "--max-bytes", "40"]);
    expect(truncated.stdout).toContain("已按 --max-bytes 截断");
  });

  it("fails closed when the directory has no dump file", () => {
    const result = runTraffic(["--dir", trafficDirectory()]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("没有找到转储文件");
  });

  it("reports a missing exchange instead of printing an empty header", () => {
    const directory = trafficDirectory();
    writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      httpExchange(1),
      websocketExchange(2),
    );

    const missing = runTraffic(["--dir", directory, "--exchange", "9"]);

    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("没有找到 exchange #9");
    expect(missing.stderr).toContain("编号范围是 #1–#2");

    const found = runTraffic(["--dir", directory, "--exchange", "2"]);
    expect(found.status).toBe(0);
    expect(found.stdout).toContain("#2");
  });

  it("rejects unknown words instead of treating them as files", () => {
    const directory = trafficDirectory();
    writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      httpExchange(1),
    );

    const result = runTraffic(["--dir", directory, "list"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("转储文件不存在：");
    expect(result.stderr).toContain("--list");
    expect(result.stderr).not.toContain("at readFileSync");

    const directoryAsFile = runTraffic([directory]);
    expect(directoryAsFile.status).toBe(1);
    expect(directoryAsFile.stderr).toContain("转储文件不存在：");
    expect(directoryAsFile.stderr).not.toContain("EISDIR");
  });

  it("follows new records until interrupted", async () => {
    const directory = trafficDirectory();
    const path = writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      httpExchange(1),
    );

    const child = spawn(
      process.execPath,
      [trafficScript, "--follow", "--dir", directory, "--max-bytes", "400"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    runningChildren.add(child);
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    await waitFor(() => output.includes("按 Ctrl-C 停止"), () => `${output}\n${errors}`);

    appendFileSync(path, `{malformed\n${dumpLines(websocketExchange(2))}`);
    await waitFor(() => output.includes("gpt-6-astra"), () => `${output}\n${errors}`);

    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolveExit) => {
      child.once("exit", resolveExit);
    });
    runningChildren.delete(child);

    expect(code).toBe(0);
    expect(output).toContain("从现有文件末尾开始跟随");
    expect(output).toContain("返回：");
    expect(output).toContain("中断 client_disconnected 连接被客户端关闭");
    expect(output).not.toContain("#1 ");
  }, 20_000);

  it("isolates follow buffers when exchange numbers restart in a new writer session", async () => {
    const directory = trafficDirectory();
    const older = writeDumpFile(
      directory,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      10,
      httpExchange(1),
    );
    const child = spawn(
      process.execPath,
      [trafficScript, "--follow", "--dir", directory, "--max-bytes", "400"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    runningChildren.add(child);
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    await waitFor(() => output.includes("按 Ctrl-C 停止"), () => `${output}\n${errors}`);

    appendFileSync(older, dumpLines([{
      direction: "client",
      exchange: 2,
      kind: "websocket_frame",
      part: 1,
      parts: 2,
      startedAtMs: 1_700_000_000_000,
      text: "{\"old\":",
    }]));
    await new Promise((resolveTick) => setTimeout(resolveTick, 1_200));
    writeDumpFile(
      directory,
      "openai-2026-09-17T00-01-00-000Z-1.jsonl",
      20,
      websocketExchange(2),
    );
    await waitFor(() => output.includes("gpt-6-astra"), () => `${output}\n${errors}`);

    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolveExit) => {
      child.once("exit", resolveExit);
    });
    runningChildren.delete(child);

    expect(code).toBe(0);
    expect(output).not.toContain("{\"old\":");
  }, 20_000);
});

function runTraffic(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [trafficScript, ...args], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

async function waitFor(ready: () => boolean, describeOutput: () => string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
  throw new Error(`等待输出超时：\n${describeOutput()}`);
}

function trafficDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-traffic-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeDumpFile(
  directory: string,
  name: string,
  modifiedAtSeconds: number,
  ...groups: Record<string, unknown>[][]
): string {
  const path = join(directory, name);
  writeFileSync(path, dumpLines(...groups), { mode: 0o600 });
  utimesSync(path, modifiedAtSeconds, modifiedAtSeconds);
  return path;
}

function dumpLines(...groups: Record<string, unknown>[][]): string {
  return groups.flat().map((record) => `${JSON.stringify({
    ts: 1_700_000_000_000,
    ...record,
  })}\n`).join("");
}

function httpExchange(exchange: number): Record<string, unknown>[] {
  const prefix = { account: "acct-openai", exchange, startedAtMs: 1_700_000_000_000 };
  const requestBody = JSON.stringify({
    input: "hello",
    model: "deepseek-flash",
    stream: true,
  });
  const responseBody = `event: response.created\ndata: ${
    JSON.stringify({ response: { model: "deepseek-flash" }, type: "response.created" })
  }\n\nevent: response.output_text.delta\ndata: ${
    JSON.stringify({ delta: "OK", type: "response.output_text.delta" })
  }\n\n`;
  return [
    {
      ...prefix,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer <redacted>",
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "turn",
          thread_id: "th-http0001-full",
          turn_id: "tu-http0001-full",
        }),
      },
      kind: "request_head",
      method: "POST",
      path: "/responses",
    },
    { ...prefix, kind: "request_body", part: 1, bytes: requestBody.length, text: requestBody },
    { ...prefix, kind: "request_end", bytes: requestBody.length },
    {
      ...prefix,
      headers: { "content-type": "text/event-stream" },
      kind: "response_head",
      status: 200,
    },
    { ...prefix, kind: "response_body", part: 1, bytes: responseBody.length, text: responseBody },
    { ...prefix, durationMs: 12, kind: "response_end", bytes: responseBody.length },
  ];
}

function websocketExchange(exchange: number): Record<string, unknown>[] {
  const prefix = { exchange, startedAtMs: 1_700_000_000_000 };
  const turnMetadata = JSON.stringify({
    request_kind: "turn",
    thread_id: "th-webs0002-full",
    turn_id: "tu-webs0002-full",
  });
  return [
    {
      ...prefix,
      headers: { "user-agent": "codex-cli" },
      kind: "websocket_handshake",
      url: "wss://chatgpt.com/backend-api/codex/responses",
    },
    {
      ...prefix,
      direction: "client",
      kind: "websocket_frame",
      part: 1,
      parts: 1,
      text: JSON.stringify({
        client_metadata: {
          "x-codex-turn-metadata": turnMetadata,
          thread_id: "th-webs0002-full",
        },
        model: "gpt-6-astra",
        type: "response.create",
      }),
    },
    {
      ...prefix,
      direction: "upstream",
      kind: "websocket_frame",
      part: 1,
      parts: 1,
      text: JSON.stringify({
        response: { model: "gpt-6-astra" },
        type: "response.created",
      }),
    },
    { ...prefix, code: 1006, kind: "websocket_close", peer: "client", reason: "client_disconnected" },
    {
      ...prefix,
      kind: "error",
      message: "连接被客户端关闭",
      scope: "client_disconnected",
    },
  ];
}

function splitWebsocketExchange(exchange: number): Record<string, unknown>[] {
  const records = websocketExchange(exchange);
  const frame = records[1] as { text: string } & Record<string, unknown>;
  const clientFrame = JSON.parse(frame.text) as Record<string, unknown>;
  const text = JSON.stringify({ ...clientFrame, padding: "x".repeat(2_048) });
  return [
    records[0] as Record<string, unknown>,
    { ...frame, part: 1, parts: 2, text: text.slice(0, 1_024) },
    { ...frame, part: 2, parts: 2, text: text.slice(1_024) },
    ...records.slice(2),
  ];
}
