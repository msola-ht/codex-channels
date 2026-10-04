import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error JavaScript route intentionally has no declaration file.
import { parseLogQuery, readServiceLogs, sanitizeLogText } from "../scripts/webui-logs-route.mjs";
import { cleanupWebuiTestFixtures, createWebuiTestFixture, startWebuiTestServer, type WebuiTestServer } from "./webui-server-test-fixture.js";
import { serviceLogEntries } from "../webui/src/lib/service-logs.js";

const directories: string[] = [];
const servers: WebuiTestServer[] = [];
afterEach(async () => cleanupWebuiTestFixtures(servers, directories));

describe("WebUI service logs", () => {
  it("accepts only bounded line counts and canonical service names", () => {
    expect(parseLogQuery(new URLSearchParams())).toEqual({ target: "gateway", lines: 100 });
    expect(parseLogQuery(new URLSearchParams("target=relay&lines=1000"))).toEqual({ target: "relay", lines: 1000 });
    for (const query of ["target=model-relay", "target=all", "target=../../secret", "lines=0", "lines=1001", "lines=1e2", "lines=02", "path=secret", "target=gateway&target=webui"]) {
      expect(() => parseLogQuery(new URLSearchParams(query))).toThrow("日志查询参数无效");
    }
  });

  it("uses fixed journald arguments, retains recent lines and reports truncation", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: ["old", "new", "latest"].map(MESSAGE => JSON.stringify({ MESSAGE })).join("\n") });
    const snapshot = await readServiceLogs({ target: "relay", lines: 2 }, { platform: "linux", environment: {}, run });
    expect(run.mock.calls[0]?.[1]).toEqual(["--user-unit=codex-connect-model-relay.service", "--lines=3", "--no-pager", "--quiet", "--output=json", "--all", "--output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_COMM"]);
    expect(run.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000, maxBuffer: 256 * 1024 });
    expect(snapshot).toMatchObject({ target: "relay", streams: [{ source: "journal", lines: ['{"MESSAGE":"new"}', '{"MESSAGE":"latest"}'], truncated: true, missing: false }] });
    run.mockResolvedValueOnce({ stdout: "" });
    expect((await readServiceLogs({ target: "gateway", lines: 2 }, { platform: "linux", run })).streams[0].lines).toEqual([]);
  });

  it("preserves systemd priorities, identifiers and subsecond time without forwarding private journal fields", async () => {
    const messages = [
      "Stopping codex-connect-gateway.service - Codex Connect Gateway...",
      "Stopped codex-connect-gateway.service - Codex Connect Gateway.",
      "codex-connect-gateway.service: Consumed 2min 32.319s CPU time, 233.5M memory peak.",
      "Started codex-connect-gateway.service - Codex Connect Gateway.",
    ];
    const run = vi.fn().mockResolvedValue({ stdout: messages.map((MESSAGE, i) => JSON.stringify({
      MESSAGE, PRIORITY: "6", SYSLOG_IDENTIFIER: "systemd", __REALTIME_TIMESTAMP: String(1791051908000123 + i * 1000),
      _CMDLINE: "PRIVATE", _EXE: "PRIVATE", __CURSOR: "PRIVATE",
    })).join("\n") });
    const result = await readServiceLogs({ target: "gateway", lines: 10 }, { platform: "linux", run });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    const entries = serviceLogEntries(result);
    expect(entries.map(entry => entry.message)).toEqual([...messages].reverse());
    expect(entries.every(entry => entry.level === "info" && entry.module === "systemd")).toBe(true);
    expect(entries[0]?.time).toBe(1791051908003.123);
  });

  it("prioritizes application severity and redacts nested JSON, multiline and binary journal messages", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: [
      { MESSAGE: '{"level":50,"msg":"Failed","module":"delivery","token":"PRIVATE"}', PRIORITY: "6", SYSLOG_IDENTIFIER: "node" },
      { MESSAGE: ["first", "token=PRIVATE"], PRIORITY: "4", SYSLOG_IDENTIFIER: "Bearer PRIVATE" },
      { MESSAGE: Array.from(Buffer.from("token=PRIVATE")), _COMM: "systemd", PRIORITY: "7" },
    ].map(entry => JSON.stringify(entry)).join("\n") });
    const result = await readServiceLogs({ target: "gateway", lines: 10 }, { platform: "linux", run });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(serviceLogEntries(result)).toMatchObject([
      { level: "error", module: "delivery", message: "Failed" },
      { level: "warn", message: "first\ntoken=[REDACTED]" },
      { level: "debug", module: "systemd" },
    ]);
    for (const stdout of ['{"MESSAGE":null}', "not-json"]) {
      run.mockResolvedValueOnce({ stdout });
      await expect(readServiceLogs({ target: "gateway", lines: 10 }, { platform: "linux", run })).rejects.toMatchObject({ code: "logs_unavailable" });
    }
  });

  it("returns a designated failure without disclosing command errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("token=PRIVATE command failure"));
    await expect(readServiceLogs({ target: "gateway", lines: 200 }, { platform: "linux", run })).rejects.toMatchObject({ status: 503, code: "logs_unavailable", message: "服务日志暂不可读取" });
    await expect(readServiceLogs({ target: "gateway", lines: 200 }, { platform: "unknown" })).rejects.toMatchObject({ code: "logs_unavailable" });
  });

  it("redacts structured secrets, whole authorization and cookie values, URLs and terminal controls", () => {
    const input = [
      '{"msg":"connected","headers":{"Authorization":"Bearer PRIVATE_A","Cookie":"a=PRIVATE_B; b=PRIVATE_C"},"apiKey":"PRIVATE_D","appSecret":"PRIVATE_E"}',
      "Authorization: Basic PRIVATE_F", "Cookie: a=PRIVATE_G; b=PRIVATE_H", "Set-Cookie: session=PRIVATE_I; HttpOnly",
      "token='PRIVATE J' password=PRIVATE_K", "https://user:PRIVATE_L@host/path?access_token=PRIVATE_M&ok=1",
      "Bearer PRIVATE_N", "\u001b[31mnormal\u001b[0m", "sk-PRIVATE_O1234",
    ].join("\n");
    const output = sanitizeLogText(input);
    expect(output).not.toContain("PRIVATE");
    expect(output).not.toContain("\u001b");
    expect(output).toContain("connected");
    expect(output).toContain("normal");
    expect(output).toContain("ok=1");
  });

  it("redacts entire structured credential values and punctuation in plain passwords", () => {
    for (const line of [
      '{"token":["PRIVATE1","PRIVATE2"],"msg":"connected"}',
      '{"credentials":{"nested":["PRIVATE1","PRIVATE2"]}}',
      '{"access_\\u0074oken":"PRIVATE1","msg":"connected"}',
      '2026-01-01 gateway[42]: {"headers":{"authorization":["PRIVATE1","PRIVATE2"]}}',
      'token=["PRIVATE1","PRIVATE2"]',
      'password=prefix&PRIVATE1;PRIVATE2',
      'password="unterminated PRIVATE1',
    ]) {
      expect(sanitizeLogText(line)).not.toContain("PRIVATE");
    }
    expect(JSON.parse(sanitizeLogText('{"token":["PRIVATE"],"msg":"connected"}'))).toEqual({ token: "[REDACTED]", msg: "connected" });
  });

  it.each(["darwin", "win32"])("reads bounded stdout and stderr tails on %s and rejects symlinks", async platform => {
    const { home, environment } = createWebuiTestFixture(directories);
    const path = join(home, "runtime", "codex-app-server.log");
    writeFileSync(path, `${"x".repeat(300_000)}\nfirst\nlast token=PRIVATE\n`);
    const options = { platform, environment };
    const snapshot = await readServiceLogs({ target: "app-server", lines: 2 }, options);
    expect(snapshot.streams).toEqual([
      { source: "stdout", lines: ["first", "last token=[REDACTED]"], truncated: true, missing: false },
      { source: "stderr", lines: [], truncated: false, missing: true },
    ]);
    if (process.platform !== "win32") {
      rmSync(path);
      symlinkSync(join(home, "private"), path);
      await expect(readServiceLogs({ target: "app-server", lines: 2 }, options)).rejects.toMatchObject({ code: "logs_unavailable" });
    }
  });

  it("uses the same configured runtime directory as the service installer", async () => {
    const { home, environment } = createWebuiTestFixture(directories);
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace("runtime/codex-app-server.sock", "custom-runtime/server.sock"));
    mkdirSync(join(home, "custom-runtime"), { mode: 0o700 });
    writeFileSync(join(home, "custom-runtime", "gateway.log"), "configured location\n");
    writeFileSync(join(home, "runtime", "gateway.log"), "wrong location\n");
    const result = await readServiceLogs({ target: "gateway", lines: 10 }, { platform: "darwin", environment: { ...environment, CODEX_CONNECT_HOME: join(home, "unused"), CODEX_CONNECT_CONFIG_FILE: configPath } });
    expect(result.streams[0].lines).toEqual(["configured location"]);
  });

  it("guards the HTTP route with existing authentication and rejects writes and invalid queries", async () => {
    const fixture = createWebuiTestFixture(directories);
    const { origin } = await startWebuiTestServer(servers, fixture.environment, undefined, { token: "test-token" });
    expect((await fetch(`${origin}/api/v1/logs`)).status).toBe(401);
    const headers = { authorization: "Bearer test-token" };
    const response = await fetch(`${origin}/api/v1/logs?target=../../secret`, { headers });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "invalid_parameter" } });
    expect((await fetch(`${origin}/api/v1/logs`, { headers, method: "POST" })).status).toBe(405);
  });
});
