import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const officialRemoteMaxPayloadBytes = 128 * 1024 * 1024;
const options = parseOptions(process.argv.slice(2));
const timeoutMs = options.timeoutMs;
const child = spawn(options.codex, ["app-server", "proxy", "--sock", options.socket], {
  cwd: options.cwd,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = Buffer.alloc(0);
let stderr = "";
let stdoutWaiter;
let childExit;
let activeScenario;

child.stdout.on("data", (chunk) => {
  stdout = Buffer.concat([stdout, chunk]);
  stdoutWaiter?.();
  stdoutWaiter = undefined;
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4_000);
});
child.stdin.on("error", () => undefined);
childExit = new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

try {
  await writeUpgradeRequest();
  const statusLine = await readUpgradeResponse();
  await writeJson({
    method: "initialize",
    id: 1,
    params: {
      clientInfo: {
        name: "codex_connect_windows_probe",
        title: "Codex Connect Windows Transport Probe",
        version: "0.150.1",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: null,
        extensions: null,
      },
    },
  });
  const initialized = await readResponse(1);
  await writeJson({ method: "initialized" });
  const threadListParams = {
    cwd: options.cwd,
    modelProviders: [],
    sourceKinds: ["cli", "vscode", "appServer"],
    sortKey: "updated_at",
    sortDirection: "desc",
    useStateDbOnly: true,
    archived: false,
    limit: 100,
  };
  await writeJson({
    method: "thread/list",
    id: 2,
    params: threadListParams,
  });
  const threads = await readResponse(2);
  const scenarioResult = options.scenario === "readonly"
    ? await holdReadonlyConnection(threadListParams)
    : options.scenario === "message-limit"
    ? await probeMessageLimit()
    : options.scenario === "peer-read"
    ? await readPeerThread()
    : await runTurnScenario();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    transport: "windows-uds-proxy",
    upgrade: statusLine,
    initialized: initialized.result !== undefined,
    platformFamily: initialized.result?.platformFamily ?? null,
    platformOs: initialized.result?.platformOs ?? null,
    threadListCount: Array.isArray(threads.result?.data) ? threads.result.data.length : null,
    ...scenarioResult,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    proxyStderr: stderr.trim() || null,
  }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const exited = await Promise.race([
    childExit,
    new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
  ]);
  if (exited === null) {
    child.kill();
    await childExit;
  }
}

async function holdReadonlyConnection(threadListParams) {
  if (options.holdMs > 0) {
    const holdResult = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve("elapsed"), options.holdMs)),
      childExit.then(() => "exit"),
    ]);
    if (holdResult === "exit") {
      throw new Error("Proxy 在已初始化连接保持期间退出");
    }
    await writeJson({ method: "thread/list", id: 3, params: threadListParams });
    await readResponse(3);
  }
  return { scenario: "readonly" };
}

async function probeMessageLimit() {
  const acceptedBytes = options.acceptedBytes;
  await writeSizedJsonRpcMessage(acceptedBytes, 30);
  const accepted = await readResponseValue(30);
  if (accepted.error === undefined && accepted.result === undefined) {
    throw new Error(`${acceptedBytes} 字节的 JSON-RPC 消息没有有效响应`);
  }
  const rejectedBytes = options.rejectedBytes;
  let writeError;
  try {
    await writeSizedJsonRpcMessage(rejectedBytes, 31);
  } catch (error) {
    writeError = error;
  }
  let closeCode;
  let rejection = "websocket-close";
  try {
    closeCode = await readOversizeClose(31);
  } catch (error) {
    if (writeError === undefined) throw error;
    const exit = await Promise.race([
      childExit,
      new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    if (exit === null) throw error;
    closeCode = null;
    rejection = "proxy-exit";
  }
  return {
    scenario: "message-limit",
    acceptedBytes,
    rejectedBytes,
    closeCode,
    rejection,
  };
}

async function runTurnScenario() {
  activeScenario = {
    name: options.scenario,
    threadId: null,
    turnId: null,
    completion: null,
    approvalRequests: 0,
    approvalAccepted: false,
  };
  await writeJson({
    method: "thread/start",
    id: 10,
    params: {
      cwd: options.cwd,
      approvalPolicy: options.scenario === "approval" ? "untrusted" : "never",
      sandbox: options.scenario === "approval" ? "workspace-write" : "read-only",
      serviceName: "codex_connect_windows_probe",
      ephemeral: true,
    },
  });
  const started = await readResponse(10);
  const threadId = started.result?.thread?.id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("thread/start 响应缺少 Thread ID");
  }
  activeScenario.threadId = threadId;
  try {
    if (options.scenario === "peer") {
      const peer = await runPeerProcess(threadId);
      if (peer.scenario !== "peer-read" || peer.peerRead !== true) {
        throw new Error("第二个 Proxy 未确认 Ephemeral Thread");
      }
      return {
        scenario: "peer",
        peerRead: true,
      };
    }
    await writeJson({
      method: "turn/start",
      id: 11,
      params: {
        threadId,
        clientUserMessageId:
          `codex_connect:windows-probe-${randomBytes(8).toString("hex")}`,
        input: [{
          type: "text",
          text: scenarioPrompt(options.scenario),
          text_elements: [],
        }],
        cwd: options.cwd,
      },
    });
    const turnStarted = await readResponse(11);
    const turnId = turnStarted.result?.turn?.id;
    if (typeof turnId !== "string" || turnId.length === 0) {
      throw new Error("turn/start 响应缺少 Turn ID");
    }
    if (
      activeScenario.turnId !== null
      && activeScenario.turnId !== turnId
    ) {
      throw new Error("turn/start 响应与完成通知的 Turn ID 不一致");
    }
    activeScenario.turnId = turnId;
    if (options.scenario === "interrupt") {
      await writeJson({
        method: "turn/interrupt",
        id: 12,
        params: { threadId, turnId },
      });
      await readResponse(12);
    }
    const completion = await waitForTurnCompletion();
    const expectedStatus = options.scenario === "interrupt" ? "interrupted" : "completed";
    if (completion.status !== expectedStatus) {
      throw new Error(
        `Turn 状态不符合预期：期望 ${expectedStatus}，实际 ${completion.status ?? "缺失"}`,
      );
    }
    if (options.scenario === "approval" && !activeScenario.approvalAccepted) {
      throw new Error("Turn 已完成但没有观察到并接受命令审批");
    }
    return {
      scenario: options.scenario,
      turnStatus: completion.status,
      approvalRequests: activeScenario.approvalRequests,
      approvalAccepted: activeScenario.approvalAccepted,
    };
  } finally {
    await writeJson({
      method: "thread/unsubscribe",
      id: 90,
      params: { threadId },
    });
    await readResponse(90);
    activeScenario = undefined;
  }
}

async function readPeerThread() {
  await writeJson({
    method: "thread/read",
    id: 20,
    params: { threadId: options.threadId, includeTurns: false },
  });
  const response = await readResponse(20);
  if (response.result?.thread?.id !== options.threadId) {
    throw new Error("第二个 Proxy 读取的 Thread ID 不一致");
  }
  return {
    scenario: "peer-read",
    peerRead: true,
  };
}

async function runPeerProcess(threadId) {
  const args = [
    fileURLToPath(import.meta.url),
    "--codex", options.codex,
    "--socket", options.socket,
    "--cwd", options.cwd,
    "--scenario", "peer-read",
    "--thread-id", threadId,
    "--timeout-ms", String(options.timeoutMs),
  ];
  const peer = spawn(process.execPath, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let peerStdout = "";
  let peerStderr = "";
  peer.stdout.setEncoding("utf8");
  peer.stderr.setEncoding("utf8");
  peer.stdout.on("data", (chunk) => {
    peerStdout = `${peerStdout}${chunk}`.slice(-8_000);
  });
  peer.stderr.on("data", (chunk) => {
    peerStderr = `${peerStderr}${chunk}`.slice(-4_000);
  });
  const exit = await new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      peer.kill();
      resolve({ code: null, timeout: true });
    }, options.timeoutMs);
    peer.once("exit", (code) => {
      clearTimeout(timeoutHandle);
      resolve({ code, timeout: false });
    });
  });
  if (exit.timeout) {
    throw new Error("第二个 Proxy 读取 Ephemeral Thread 超时");
  }
  if (exit.code !== 0) {
    throw new Error(`第二个 Proxy 失败：${peerStderr.trim() || "无 stderr"}`);
  }
  return JSON.parse(peerStdout);
}

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        "--codex",
        "--socket",
        "--cwd",
        "--hold-ms",
        "--scenario",
        "--timeout-ms",
        "--thread-id",
        "--accepted-bytes",
        "--rejected-bytes",
      ]
        .includes(name)
      || value === undefined
    ) {
      throw new Error("用法：node scripts/windows-app-server-proxy-probe.mjs --codex <codex.exe> --socket <绝对路径> --cwd <绝对路径> [--scenario <readonly|peer|message-limit|turn|approval|interrupt>] [--hold-ms <毫秒>] [--timeout-ms <毫秒>]");
    }
    values.set(name, value);
  }
  const codex = values.get("--codex");
  const socket = values.get("--socket");
  const cwd = values.get("--cwd");
  if (![codex, socket, cwd].every((value) => typeof value === "string" && isAbsolute(value))) {
    throw new Error("--codex、--socket 和 --cwd 必须是绝对路径");
  }
  const holdMs = Number(values.get("--hold-ms") ?? 0);
  if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 60_000) {
    throw new Error("--hold-ms 必须是 0 到 60000 的整数");
  }
  const scenario = values.get("--scenario") ?? "readonly";
  if (![
    "readonly",
    "peer",
    "peer-read",
    "message-limit",
    "turn",
    "approval",
    "interrupt",
  ].includes(scenario)) {
    throw new Error("--scenario 必须是 readonly、peer、message-limit、turn、approval 或 interrupt");
  }
  if (scenario !== "readonly" && holdMs !== 0) {
    throw new Error("--hold-ms 只可用于 readonly 场景");
  }
  const timeoutMs = Number(
    values.get("--timeout-ms") ?? (scenario === "readonly" ? 10_000 : 90_000),
  );
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("--timeout-ms 必须是 1000 到 120000 的整数");
  }
  const threadId = values.get("--thread-id");
  if (
    (scenario === "peer-read" && (typeof threadId !== "string" || threadId.length === 0))
    || (scenario !== "peer-read" && threadId !== undefined)
  ) {
    throw new Error("--thread-id 只可由 peer 场景的内部读取进程使用");
  }
  const acceptedBytes = Number(
    values.get("--accepted-bytes") ?? 64 * 1024 * 1024,
  );
  const rejectedBytes = Number(
    values.get("--rejected-bytes") ?? 96 * 1024 * 1024,
  );
  if (
    !Number.isSafeInteger(acceptedBytes)
    || !Number.isSafeInteger(rejectedBytes)
    || acceptedBytes < 1_024
    || rejectedBytes <= acceptedBytes
    || rejectedBytes > officialRemoteMaxPayloadBytes + 1
  ) {
    throw new Error("消息边界必须满足 1024 <= --accepted-bytes < --rejected-bytes <= 128 MiB + 1");
  }
  if (
    scenario !== "message-limit"
    && (
      values.has("--accepted-bytes")
      || values.has("--rejected-bytes")
    )
  ) {
    throw new Error("--accepted-bytes 和 --rejected-bytes 只可用于 message-limit 场景");
  }
  return {
    codex,
    socket,
    cwd,
    holdMs,
    scenario,
    timeoutMs,
    threadId,
    acceptedBytes,
    rejectedBytes,
  };
}

function scenarioPrompt(scenario) {
  if (scenario === "turn") {
    return "Reply with exactly OK. Do not call tools.";
  }
  if (scenario === "approval") {
    return "Run exactly `node --version` once using the shell, then reply DONE.";
  }
  return "Continue reasoning until interrupted. Do not call tools or finish early.";
}

async function writeUpgradeRequest() {
  const key = randomBytes(16).toString("base64");
  await writeBytes(Buffer.from([
    "GET / HTTP/1.1",
    "Host: localhost",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n"), "ascii"));
}

async function readUpgradeResponse() {
  const boundary = Buffer.from("\r\n\r\n", "ascii");
  while (stdout.indexOf(boundary) === -1) {
    await waitForStdout();
  }
  const end = stdout.indexOf(boundary) + boundary.length;
  const response = stdout.subarray(0, end).toString("ascii");
  stdout = stdout.subarray(end);
  const [statusLine] = response.split("\r\n");
  if (!/^HTTP\/1\.1 101\b/u.test(statusLine)) {
    throw new Error(`WebSocket Upgrade 失败：${statusLine}`);
  }
  return statusLine;
}

async function writeJson(value) {
  await writeBytes(encodeClientFrame(JSON.stringify(value)));
}

async function writeSizedJsonRpcMessage(totalBytes, id) {
  const prefix = Buffer.from(
    `{"method":"codex-connect/windows-message-limit-probe","id":${id},"params":{"padding":"`,
    "utf8",
  );
  const suffix = Buffer.from('"}}', "utf8");
  if (totalBytes <= prefix.length + suffix.length) {
    throw new Error("消息上限探针长度不足");
  }
  const fragmentBytes = 1024 * 1024;
  for (let offset = 0; offset < totalBytes; offset += fragmentBytes) {
    const length = Math.min(fragmentBytes, totalBytes - offset);
    const payload = sizedMessageSlice(prefix, suffix, totalBytes, offset, length);
    await writeUnmaskedPayloadFrame(
      payload,
      offset === 0 ? 0x1 : 0x0,
      offset + length === totalBytes,
    );
  }
}

function sizedMessageSlice(prefix, suffix, totalBytes, offset, length) {
  const payload = Buffer.alloc(length, 0x78);
  const end = offset + length;
  const prefixStart = Math.max(offset, 0);
  const prefixEnd = Math.min(end, prefix.length);
  if (prefixStart < prefixEnd) {
    prefix.copy(payload, prefixStart - offset, prefixStart, prefixEnd);
  }
  const suffixOffset = totalBytes - suffix.length;
  const suffixStart = Math.max(offset, suffixOffset);
  const suffixEnd = Math.min(end, totalBytes);
  if (suffixStart < suffixEnd) {
    suffix.copy(
      payload,
      suffixStart - offset,
      suffixStart - suffixOffset,
      suffixEnd - suffixOffset,
    );
  }
  return payload;
}

async function writeUnmaskedPayloadFrame(payload, opcode, final) {
  const header = Buffer.alloc(14);
  header[0] = (final ? 0x80 : 0) | opcode;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  await writeBytes(header);
  await writeBytes(payload);
}

async function readResponse(id) {
  const message = await readResponseValue(id);
  if (message.error !== undefined) {
    throw new Error(`JSON-RPC ${id} 失败：${JSON.stringify(message.error)}`);
  }
  return message;
}

async function readResponseValue(id) {
  for (;;) {
    const message = await readJsonMessage();
    if (message.id !== id) continue;
    return message;
  }
}

async function readOversizeClose(id) {
  for (;;) {
    const frame = await readFrame();
    if (frame.opcode === 0x8) {
      return frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null;
    }
    if (frame.opcode === 0x9) {
      await writeBytes(encodeClientFrame(frame.payload, 0xA));
      continue;
    }
    if (frame.opcode !== 0x1) continue;
    const message = JSON.parse(frame.payload.toString("utf8"));
    if (message.id === id) {
      throw new Error(`${options.rejectedBytes} 字节的 JSON-RPC 消息未被拒绝`);
    }
    await observeMessage(message);
  }
}

async function waitForTurnCompletion() {
  for (;;) {
    if (activeScenario?.completion !== null) return activeScenario.completion;
    await readJsonMessage();
  }
}

async function readJsonMessage() {
  for (;;) {
    const frame = await readFrame();
    if (frame.opcode === 0x8) {
      throw new Error("Proxy 在 JSON-RPC 完成前关闭 WebSocket");
    }
    if (frame.opcode === 0x9) {
      await writeBytes(encodeClientFrame(frame.payload, 0xA));
      continue;
    }
    if (frame.opcode !== 0x1) continue;
    const message = JSON.parse(frame.payload.toString("utf8"));
    await observeMessage(message);
    return message;
  }
}

async function observeMessage(message) {
  if (
    message.method === "turn/completed"
    && activeScenario !== undefined
    && message.params?.threadId === activeScenario.threadId
    && typeof message.params?.turn?.id === "string"
    && (
      activeScenario.turnId === null
      || message.params.turn.id === activeScenario.turnId
    )
  ) {
    activeScenario.turnId = message.params.turn.id;
    activeScenario.completion = {
      status: message.params.turn.status,
    };
    return;
  }
  if (message.method === "item/commandExecution/requestApproval" && message.id !== undefined) {
    if (activeScenario?.name !== "approval") {
      await writeJson({ id: message.id, result: { decision: "decline" } });
      throw new Error("非审批场景收到命令审批请求");
    }
    activeScenario.approvalRequests += 1;
    const command = message.params?.command;
    const actionCommands = Array.isArray(message.params?.commandActions)
      ? message.params.commandActions
        .map((action) => action?.command)
        .filter((candidate) => typeof candidate === "string")
      : [];
    if (
      ![command, ...actionCommands]
        .some((candidate) => typeof candidate === "string" && isExactNodeVersionCommand(candidate))
    ) {
      await writeJson({ id: message.id, result: { decision: "decline" } });
      throw new Error("审批场景收到非预期命令，已拒绝");
    }
    await writeJson({ id: message.id, result: { decision: "accept" } });
    activeScenario.approvalAccepted = true;
    return;
  }
  if (message.method !== undefined && message.id !== undefined) {
    await writeJson({
      id: message.id,
      error: { code: -32601, message: "Windows 探针不支持该 Server Request" },
    });
    throw new Error(`收到不支持的 Server Request：${message.method}`);
  }
}

function isExactNodeVersionCommand(command) {
  const nodeVersion = String.raw`node(?:\.exe)?\s+--version`;
  const absoluteNodeVersion =
    String.raw`(?:(?:"[A-Za-z]:\\[^"\r\n]*\\node\.exe")|(?:[A-Za-z]:\\\S*\\node\.exe))\s+--version`;
  const quotedNodeVersion = String.raw`["']?${nodeVersion}["']?`;
  return [
    new RegExp(`^${quotedNodeVersion}$`, "iu"),
    new RegExp(`^${absoluteNodeVersion}$`, "iu"),
    new RegExp(
      String.raw`^cmd(?:\.exe)?\s+/d\s+/s\s+/c\s+${quotedNodeVersion}$`,
      "iu",
    ),
    new RegExp(
      String.raw`^(?:powershell|pwsh)(?:\.exe)?\s+(?:-NoProfile\s+)?-Command\s+${quotedNodeVersion}$`,
      "iu",
    ),
  ].some((pattern) => pattern.test(command.trim()));
}

async function readFrame() {
  await ensureStdout(2);
  const first = stdout[0];
  const second = stdout[1];
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7F;
  let offset = 2;
  if (payloadLength === 126) {
    await ensureStdout(offset + 2);
    payloadLength = stdout.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    await ensureStdout(offset + 8);
    const longLength = stdout.readBigUInt64BE(offset);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket Frame 超过 JavaScript 安全长度");
    }
    payloadLength = Number(longLength);
    offset += 8;
  }
  const maskLength = masked ? 4 : 0;
  await ensureStdout(offset + maskLength + payloadLength);
  const mask = masked ? stdout.subarray(offset, offset + 4) : null;
  offset += maskLength;
  const payload = Buffer.from(stdout.subarray(offset, offset + payloadLength));
  stdout = stdout.subarray(offset + payloadLength);
  if (mask !== null) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode: first & 0x0F, payload };
}

function encodeClientFrame(value, opcode = 0x1) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const mask = randomBytes(4);
  let header;
  if (payload.length <= 125) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xFFFF) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const maskedPayload = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    maskedPayload[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, maskedPayload]);
}

async function ensureStdout(length) {
  while (stdout.length < length) {
    await waitForStdout();
  }
}

async function waitForStdout() {
  let timeoutHandle;
  let exited;
  try {
    exited = await Promise.race([
      new Promise((resolve) => {
        stdoutWaiter = () => resolve("data");
      }),
      childExit.then(() => "exit"),
      new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    stdoutWaiter = undefined;
    clearTimeout(timeoutHandle);
  }
  if (exited === "timeout") throw new Error(`等待 Proxy 输出超时：${timeoutMs}ms`);
  if (exited === "exit") {
    throw new Error(`Proxy 提前退出：${stderr.trim() || "无 stderr"}`);
  }
}

async function writeBytes(bytes) {
  await new Promise((resolve, reject) => {
    child.stdin.write(bytes, (error) => error ? reject(error) : resolve());
  });
}
