import { randomUUID } from "node:crypto";
import {
  existsSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { readGatewayConfig, validateGatewayConfigStructureDocument } from "../runtime/gateway-config.mjs";
import {
  ensurePrivateDirectorySync,
  writePrivateFileAtomicSync,
} from "../runtime/private-file.mjs";
import {
  locateUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";
import {
  assertAbsoluteChannelImagePath,
  CHANNEL_SEND_IMAGE_USAGE,
  parseChannelSendImageArgs,
} from "./channel-send-image-options.mjs";
import { assertStateDatabaseSchema } from "./state-database.mjs";

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
  assertAbsoluteChannelImagePath(imagePath);
  const { readGeneratedImage, GeneratedImageError } = await import("../dist/surfaces/index.js");
  let image;
  try {
    image = await readGeneratedImage(imagePath);
  } catch (error) {
    if (!(error instanceof GeneratedImageError)) throw error;
    throw new Error("图片必须是绝对路径的普通文件（非符号链接），PNG/JPEG，大小 1 字节到 10 MiB", { cause: error });
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
  ensurePrivateDirectorySync(runtime.spoolDirectory);
  ensurePrivateDirectorySync(pendingDirectory);
  const base = randomUUID();
  const pendingImage = join(pendingDirectory, `${base}.${image.format === "jpeg" ? "jpg" : "png"}`);
  const manifestPath = join(pendingDirectory, `${base}.json`);
  const stagedManifestPath = join(pendingDirectory, `.${base}.pending`);
  try {
    writePrivateFileAtomicSync(pendingImage, image.bytes);
    // Publish only after the validated bytes are complete and private.
    writePrivateFileAtomicSync(stagedManifestPath, `${JSON.stringify({
        version: 1,
        threadId: resolvedThreadId,
        imagePath: pendingImage,
        createdAtMs: now(),
      }, null, 2)}\n`);
    renameSync(stagedManifestPath, manifestPath);
  } catch (error) {
    rmSync(stagedManifestPath, { force: true });
    rmSync(pendingImage, { force: true });
    throw error;
  }
  return {
    manifestPath,
    imagePath: pendingImage,
    threadId: resolvedThreadId,
    target,
    spoolDirectory: runtime.spoolDirectory,
  };
}

export function resolveRuntimePaths({ environment, stateDatabasePath, spoolDirectory, spoolDirectoryName = "channel-outbox" }) {
  const userConfig = locateUserConfig(environment);
  const document = readGatewayConfig(userConfig.configPath);
  validateGatewayConfigStructureDocument(document);
  const resolvedStatePath = stateDatabasePath
    ?? resolveConfiguredPath(
      document.storage?.database_path,
      userConfig.dataDir,
      "data/gateway.sqlite3",
    );
  return {
    stateDatabasePath: resolvedStatePath,
    spoolDirectory: spoolDirectory
      ?? join(dirname(resolvedStatePath), spoolDirectoryName),
  };
}

export function readBindings(stateDatabasePath) {
  if (!existsSync(stateDatabasePath)) {
    throw new Error(`状态数据库不存在，请先启动 Gateway：${stateDatabasePath}`);
  }
  const database = new DatabaseSync(stateDatabasePath, { readOnly: true });
  try {
    assertStateDatabaseSchema(database);
    return database.prepare(`
      SELECT thread_id AS threadId, surface, account_id AS accountId,
             conversation_id AS conversationId
      FROM conversation_bindings
      UNION
      SELECT thread_id AS threadId, surface, account_id AS accountId,
             conversation_id AS conversationId
      FROM conversation_background_bindings
    `).all();
  } finally {
    database.close();
  }
}

export function resolveThreadId(bindings, requestedThreadId) {
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

function printResult(result) {
  writeCliMessage("success", "已提交渠道图片发送，网关发送后自动归档。");
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
      console.log(`${CHANNEL_SEND_IMAGE_USAGE}

把本地 PNG/JPEG 图片（最大 10 MiB）交给 Gateway，由 Thread 绑定渠道的机器人凭据发送回对应会话。
不指定 --thread 时，只有当前仅存在一个会话绑定才会自动选择目标。`);
      process.exit(0);
    }
    const parsed = parseChannelSendImageArgs(args);
    printResult(await submitChannelImage(parsed));
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
