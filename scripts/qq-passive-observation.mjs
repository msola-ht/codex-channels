import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Agent as HttpsAgent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { PrivateIpcServer } from "../runtime/private-ipc.mjs";
import { readGatewayConfig, validateGatewayConfigStructureDocument } from "../runtime/gateway-config.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

const usage = `QQ 有界消息观察（仅源码工作区手动运行）
用法：node scripts/qq-passive-observation.mjs --run
      node scripts/qq-passive-observation.mjs --text-samples|--reply-budget|--reply-window
      node scripts/qq-passive-observation.mjs --reconnect
      node scripts/qq-passive-observation.mjs -h|--help

保持 Gateway 运行，但正式配置必须 qq.enabled=false，并确认该配置已经生效。
脚本读取保留的凭据，要求允许名单恰好一人，使用独立的 QQ 探测互斥，不占用 Gateway 所有权。
看到就绪提示后，用允许的 QQ 用户发送本次随机口令；--run 最多回复一次固定短文本。
除窗口模式外总观察时间最多 180 秒，另有最多 8 秒清理；Ctrl+C 可取消。不启动 Codex 任务。
--text-samples：收到口令后主动发送 5 个固定文字样例；--reply-budget：同一来信最多 6 次请求（含一次重复序号）。
--reply-window：收到口令后保持连接，到原来信超过 310 秒时被动回复一次，总期限 480 秒。
--reconnect：收到口令后只断开本脚本自己的一个网络连接，观察恢复后被动回复一次。
不保存或回显凭据、OpenID、消息 ID 和来信正文。无需启停 Gateway 或 App Server。
探测期间不要启用正式 QQ；检测到启用、凭据或名单变化会取消。不是正式消息入口，不随 npm 打包。
`;

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && ["-h", "--help"].includes(args[0]))) {
  process.stdout.write(usage);
} else if (args.length !== 1 || !["--run", "--text-samples", "--reply-budget", "--reply-window", "--reconnect"].includes(args[0])) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else {
  await observe(args[0]);
}

async function observe(mode) {
  const lifetime = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => lifetime.abort(), mode === "--reply-window" ? 480_000 : 180_000);
  const cancel = () => lifetime.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let owner, network, client, transport, monitor;
  const directAgents = new Set();
  const sockets = new Set();
  let attempted = false;
  let result;
  let phase = "preflight";
  const report = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    const { configPath } = requireUserConfig(process.env, { readOnly: true });
    const readAccount = () => {
      const raw = validateGatewayConfigStructureDocument(readGatewayConfig(configPath)).qq;
      if (!raw || raw.enabled !== false || !raw.app_id || !raw.app_secret || raw.allowed_user_openids?.length !== 1) throw new Error();
      return { appId: raw.app_id, appSecret: raw.app_secret, recipient: raw.allowed_user_openids[0] };
    };
    const account = readAccount();
    const recipient = account.recipient;
    phase = "observation-lock";
    const key = createHash("sha256").update(account.appId).digest("hex").slice(0, 16);
    owner = new PrivateIpcServer(join(dirname(configPath), "runtime", `qq-observation-${key}.sock`),
      socket => { socket.on("error", () => {}); socket.end("QQ observation active\n"); },
      { connectionTimeoutMs: 1000, maximumConnections: 4 });
    await owner.start("QQ 探测已在运行或互斥状态未确认");
    lifetime.signal.throwIfAborted();
    phase = "load-built-modules";
    const [{ loadConfigDocument }, { createQqNetwork }, { loadQqSurface }] = await Promise.all([
      import("../dist/config/index.js"),
      import("../dist/bootstrap/qq-network.js"),
      import("../dist/surfaces/index.js"),
    ]);
    const { QqProtocolClient, QqWebSocketTransport } = await loadQqSurface();
    const load = () => loadConfigDocument(readFileSync(configPath, "utf8"), dirname(configPath),
      { environment: process.env, detectSystemProxy: true });
    const config = load();
    const assertCurrent = () => {
      lifetime.signal.throwIfAborted();
      const current = readAccount();
      if (current.appId !== account.appId || current.appSecret !== account.appSecret || current.recipient !== recipient) throw new Error();
    };
    assertCurrent();
    monitor = setInterval(() => {
      try { assertCurrent(); } catch { lifetime.abort("configuration-changed"); }
    }, 500);
    const phrase = `QQ探测-${randomBytes(4).toString("hex")}`;
    let admit;
    let accepted = false;
    const incoming = new Promise(resolve => { admit = resolve; });
    let connectionCount = 0;
    let resumeObserved = false;
    let reconnected;
    const reconnection = new Promise(resolve => { reconnected = resolve; });
    const captureSocket = socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      return socket;
    };
    network = createQqNetwork(config.networkProxy);
    client = new QqProtocolClient({ appId: account.appId, appSecret: account.appSecret, fetchImpl: network.fetchImpl });
    transport = new QqWebSocketTransport({
      client,
      agentForUrl: (url, signal) => {
        const agent = network.agentForUrl(url, signal);
        if (mode !== "--reconnect") return agent;
        if (agent) {
          const connect = agent.connect.bind(agent);
          agent.connect = async (...values) => captureSocket(await connect(...values));
          return agent;
        }
        const direct = new HttpsAgent();
        const createConnection = direct.createConnection.bind(direct);
        direct.createConnection = (...values) => captureSocket(createConnection(...values));
        directAgents.add(direct);
        return direct;
      },
      releaseAgent: agent => {
        if (directAgents.delete(agent)) { agent.destroy(); return Promise.resolve(); }
        return network.releaseAgent(agent);
      },
      onStatus: status => {
        report({ connection: status });
        if (status === "ready" && ++connectionCount > 1) reconnected();
      },
      onDispatch: async (event, signal) => {
        signal.throwIfAborted();
        lifetime.signal.throwIfAborted();
        if (event.t === "RESUMED") resumeObserved = true;
        if (accepted || event.t !== "C2C_MESSAGE_CREATE") return;
        const data = event.d;
        if (!data || typeof data !== "object" || data.author?.user_openid !== recipient
          || typeof data.content !== "string" || data.content.trim() !== phrase) return;
        accepted = true;
        admit(data);
      },
    });
    const cancelled = new Promise((_, reject) => {
      lifetime.signal.addEventListener("abort", () => reject(new Error()), { once: true });
      if (lifetime.signal.aborted) reject(new Error());
    });
    const disconnected = transport.finished.then(() => { throw new Error(); });
    // Both promises are observed immediately, including cancellation before READY.
    phase = "connect";
    await Promise.race([transport.start(), cancelled, disconnected]);
    assertCurrent();
    process.stdout.write(`就绪。请用允许的 QQ 用户向机器人发送：${phrase}\n`);
    phase = "receive";
    const data = await Promise.race([incoming, cancelled, disconnected]);
    const ext = Array.isArray(data.message_scene?.ext) ? data.message_scene.ext : [];
    report({ inbound: {
      messageType: Number.isInteger(data.message_type) ? data.message_type : null,
      defaultScene: data.message_scene?.source === "default",
      msgIdxCount: ext.filter(value => typeof value === "string" && value.startsWith("msg_idx=")).length,
      hasAttachments: Array.isArray(data.attachments) && data.attachments.length > 0,
    } });
    phase = "validate-inbound";
    const sentAt = Date.parse(data.timestamp);
    if (typeof data.id !== "string" || !/^[\x21-\x7e]{1,512}$/.test(data.id)
      || !Number.isFinite(sentAt) || sentAt < startedAt - 10_000 || sentAt > Date.now() + 10_000
      || (data.message_type !== undefined && data.message_type !== 0)
      || (data.attachments !== undefined && (!Array.isArray(data.attachments) || data.attachments.length > 0))
      || data.ark_data != null || (data.msg_elements !== undefined && (!Array.isArray(data.msg_elements) || data.msg_elements.length > 0))) throw new Error();
    // Optional event fields are observed, not defaulted into a production input contract.
    let requests = 0;
    const send = async (sample, content, seq) => {
      assertCurrent();
      phase = "token";
      const signal = globalThis.AbortSignal.any([lifetime.signal, globalThis.AbortSignal.timeout(15_000)]);
      const token = await client.getAccessToken(signal);
      assertCurrent();
      signal.throwIfAborted();
      if (seq !== undefined && mode !== "--reply-window" && Date.now() - sentAt >= 300_000) throw new Error();
      phase = "send";
      attempted = true;
      requests++;
      const response = await network.fetchImpl(`https://api.bot.qq.com/v2/users/${encodeURIComponent(recipient)}/messages`, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify({ msg_type: 0, content, ...(seq === undefined ? {} : { msg_id: data.id, msg_seq: seq }) }),
      });
      const value = await boundedJson(response);
      const code = typeof value?.code === "number" ? value.code : undefined;
      const hasId = typeof value?.id === "string" && /^[\x21-\x7e]{1,512}$/.test(value.id);
      const observation = { sample, requests, mode: seq === undefined ? "active" : "passive", seq,
        utf8Bytes: Buffer.byteLength(content), utf16Units: content.length, codePoints: [...content].length,
        sourceAgeSeconds: Math.floor((Date.now() - sentAt) / 1000),
        httpStatus: response.status, businessCode: code, messageIdPresent: hasId,
        accepted: response.status === 200 && hasId && (code === undefined || code === 0), timestamp: new Date().toISOString() };
      report(observation);
      if (!observation.accepted && !(Number.isInteger(code) && code !== 0 && response.status < 500)) throw new Error();
      return observation;
    };
    if (mode === "--reconnect") {
      phase = "controlled-disconnect";
      await delay(100, undefined, { signal: lifetime.signal });
      assertCurrent();
      if (sockets.size !== 1) throw new Error();
      report({ reconnect: "destroy-one-owned-socket" });
      [...sockets][0].destroy();
      const timeout = delay(30_000, undefined, { signal: lifetime.signal }).then(() => { throw new Error(); });
      await Promise.race([reconnection, cancelled, disconnected, timeout]);
      report({ reconnect: "ready-again", resumeObserved });
      await send("R1", "QQ 重连探测 R1：独立连接恢复后的被动回复。", 1);
    } else if (mode === "--reply-window") {
      phase = "wait-window";
      while (Date.now() - sentAt < 311_000) {
        assertCurrent();
        report({ waitingFor: "W1-after-310-seconds", sourceAgeSeconds: Math.floor((Date.now() - sentAt) / 1000) });
        await delay(Math.min(30_000, 311_000 - (Date.now() - sentAt)), undefined, { signal: lifetime.signal });
      }
      await send("W1", "QQ 窗口探测 W1：原来信超过 310 秒后的被动回复。", 1);
    } else if (mode === "--reply-budget") {
      for (const [sample, seq] of [["Q1", 1], ["Q1-duplicate", 1], ["Q2", 2], ["Q3", 3], ["Q4", 4], ["Q5", 5]]) {
        await send(sample, `QQ 回复预算探测 Q${seq}：固定短文本。`, seq);
        await delay(1200, undefined, { signal: lifetime.signal });
      }
    } else if (mode === "--text-samples") {
      const samples = [
        ["T1", "ASCII ".repeat(160)], ["T2", "中文段落".repeat(250)],
        ["T3", "🙂".repeat(750)], ["T4", "代码与换行\n```js\nconst x = 1;\n```\ne\u0301 / 👩‍💻\n".repeat(8)],
        ["T5", "A".repeat(6000)],
      ];
      for (const [sample, body] of samples) {
        await send(sample, `[QQ ${sample} BEGIN]\n${body}\n[QQ ${sample} END]`);
        await delay(1500, undefined, { signal: lifetime.signal });
      }
    } else {
      await send("B1", "QQ 基础探测 B1：被动回复。仅验证收发，不启动任务。", 1);
    }
    result = { mode, requests, observation: "finished", clientReceipt: "请在 QQ 确认各样例实际显示；finished 不表示全部被接受" };
  } catch {
    process.exitCode = 1;
    result = { phase, attempted, result: attempted ? "unconfirmed-no-retry" : "not-sent",
      reason: lifetime.signal.reason === "configuration-changed" ? "configuration-changed"
        : lifetime.signal.aborted ? "cancelled-or-deadline"
          : phase === "observation-lock" ? "observation-lock-unavailable" : "operation-failed" };
  } finally {
    clearTimeout(timer);
    clearInterval(monitor);
    lifetime.abort();
    client?.close();
    for (const socket of sockets) socket.destroy();
    for (const agent of directAgents) agent.destroy();
    const watchdog = setTimeout(() => {
      report({ cleanup: "unconfirmed", instruction: "进程即将退出；确认退出前不要启用正式 QQ 或启动下一次探测" });
      process.exit(1);
    }, 8_000);
    const closed = await Promise.allSettled([transport?.stop(), network?.close()]);
    const ownerClosed = await Promise.allSettled([owner?.close()]);
    clearTimeout(watchdog);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if ([...closed, ...ownerClosed].some(entry => entry.status === "rejected")) {
      report({ cleanup: "unconfirmed" });
      process.exitCode = 1;
    } else report({ cleanup: "closed" });
    if (result) report(result);
    process.stdout.write("探测结束；Gateway 可继续运行，正式 QQ 保持禁用。\n");
  }
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
