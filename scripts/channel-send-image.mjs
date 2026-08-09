import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  locateUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";

const maximumChannelImageBytes = 10 * 1024 * 1024;

export async function submitChannelImage({
  environment = process.env,
  imagePath,
  threadId,
  stateDatabasePath,
  spoolDirectory,
  now = () => Date.now(),
} = {}) {
  if (typeof imagePath !== "string" || imagePath.length === 0) {
    throw new Error("请提供要发送的图片路径：codexc channel send-image <图片路径>");
  }
  if (!isAbsolute(imagePath)) {
    throw new Error("图片路径必须是绝对路径");
  }
  if (!existsSync(imagePath) || !statSync(imagePath).isFile()) {
    throw new Error(`图片文件不存在：${imagePath}`);
  }
  const stat = statSync(imagePath);
  if (stat.size <= 0 || stat.size > maximumChannelImageBytes) {
    throw new Error("图片大小必须在 1 字节到 10 MiB 之间");
  }

  const runtime = resolveRuntimePaths({
    environment,
    stateDatabasePath,
    spoolDirectory,
  });
  const bindings = readBindings(runtime.stateDatabasePath);
  const resolvedThreadId = resolveThreadId(
    bindings,
    threadId,
  );
  const target = bindings.find((binding) => binding.threadId === resolvedThreadId);
  if (target === undefined) {
    throw new Error(`Thread 未绑定会话：${resolvedThreadId}`);
  }

  const pendingDirectory = join(runtime.spoolDirectory, "pending");
  mkdirSync(pendingDirectory, { recursive: true });
  chmodSync(pendingDirectory, 0o700);
  const base = randomUUID();
  const extension = imageExtension(imagePath);
  const pendingImage = join(pendingDirectory, `${base}${extension}`);
  copyFileSync(imagePath, pendingImage);
  chmodSync(pendingImage, 0o600);
  const manifestPath = join(pendingDirectory, `${base}.json`);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      threadId: resolvedThreadId,
      imagePath: pendingImage,
      createdAtMs: now(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(manifestPath, 0o600);
  return {
    manifestPath,
    imagePath: pendingImage,
    threadId: resolvedThreadId,
    target,
    spoolDirectory: runtime.spoolDirectory,
  };
}

function resolveRuntimePaths({ environment, stateDatabasePath, spoolDirectory }) {
  const userConfig = locateUserConfig(environment);
  const document = readGatewayConfig(userConfig.configPath);
  const resolvedStatePath = stateDatabasePath
    ?? resolveConfiguredPath(
      document.storage?.database_path,
      userConfig.dataDir,
      "data/gateway.sqlite3",
    );
  return {
    stateDatabasePath: resolvedStatePath,
    spoolDirectory: spoolDirectory
      ?? join(dirname(resolvedStatePath), "channel-outbox"),
  };
}

function readBindings(stateDatabasePath) {
  if (!existsSync(stateDatabasePath)) {
    throw new Error(`状态数据库不存在，请先启动 Gateway：${stateDatabasePath}`);
  }
  const database = new DatabaseSync(stateDatabasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT thread_id AS threadId, surface, account_id AS accountId,
             conversation_id AS conversationId
      FROM conversation_bindings
    `).all();
  } finally {
    database.close();
  }
}

function resolveThreadId(bindings, requestedThreadId) {
  if (typeof requestedThreadId === "string" && requestedThreadId.length > 0) {
    if (!bindings.some((binding) => binding.threadId === requestedThreadId)) {
      throw new Error(`Thread 未绑定会话：${requestedThreadId}`);
    }
    return requestedThreadId;
  }
  if (bindings.length === 0) {
    throw new Error("当前没有已绑定的渠道会话，无法确定发送目标");
  }
  if (bindings.length > 1) {
    throw new Error(
      `当前有 ${bindings.length} 个渠道会话绑定，请用 --thread <Thread ID> 指定目标`,
    );
  }
  return bindings[0].threadId;
}

function imageExtension(path) {
  const match = path.match(/\.([a-zA-Z0-9]{1,10})$/u);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function printResult(result) {
  console.log("已提交渠道图片发送，网关发送后自动归档。");
  console.log(`Thread：${result.threadId}`);
  console.log(`渠道：${result.target.surface}（${result.target.conversationId}）`);
  console.log(`图片：${result.imagePath}`);
  console.log(`失败保留：${join(result.spoolDirectory, "failed")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = process.argv.slice(2);
    const help = args.length === 1 && (args[0] === "-h" || args[0] === "--help");
    if (help) {
      console.log(`用法：codexc channel send-image <图片路径> [--thread <Thread ID>]

把本地 PNG/JPEG 图片（最大 10 MiB）交给 Gateway，由当前渠道机器人凭据发送回绑定会话。
不指定 --thread 时，只有当前仅存在一个会话绑定才会自动选择目标。`);
      process.exit(0);
    }
    let threadId;
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--thread") {
        threadId = args[index + 1];
        if (!threadId) {
          throw new Error("--thread 缺少值");
        }
        index += 1;
        continue;
      }
      if (args[index].startsWith("-")) {
        throw new Error(`未知参数：${args[index]}`);
      }
      positional.push(args[index]);
    }
    if (positional.length !== 1) {
      throw new Error("用法：codexc channel send-image <图片路径> [--thread <Thread ID>]");
    }
    printResult(await submitChannelImage({ imagePath: positional[0], threadId }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
