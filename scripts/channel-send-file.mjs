import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { ensurePrivateDirectorySync, writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { readBindings, resolveRuntimePaths, resolveThreadId } from "./channel-send-image.mjs";
import { CHANNEL_SEND_FILE_USAGE, parseChannelSendFileArgs } from "./channel-send-file-options.mjs";

export async function submitChannelFile({
  environment = process.env, filePath, threadId, mediaType = "file", stateDatabasePath, spoolDirectory, now = () => Date.now(),
} = {}) {
  const { readBoundedLocalFile, assertChannelFileName, channelFilePolicy, maximumQqChannelFileBytes } = await import("../dist/surfaces/index.js");
  const fileName = typeof filePath === "string" ? basename(filePath) : undefined;
  let bytes;
  try {
    assertChannelFileName(fileName);
    bytes = await readBoundedLocalFile(filePath, maximumQqChannelFileBytes);
  } catch {
    throw new Error("文件必须是绝对路径的非符号链接普通文件，读取上限 64 MiB；内容不可为空，文件名限 255 UTF-8 字节且不可含控制符或路径分隔符");
  }
  let runtime;
  let bindings;
  try {
    runtime = resolveRuntimePaths({ environment, stateDatabasePath, spoolDirectory, spoolDirectoryName: "channel-file-outbox" });
    bindings = readBindings(runtime.stateDatabasePath);
  } catch {
    throw new Error("无法读取当前 Gateway 配置或兼容的状态数据库，请核对本机配置、数据库版本和访问权限");
  }
  const resolvedThreadId = resolveThreadId(bindings, threadId);
  const targets = bindings.filter(binding => binding.threadId === resolvedThreadId);
  if (targets.length !== 1) throw new Error("Thread 的渠道绑定不唯一，拒绝发送文件");
  const target = targets[0];
  const policy = channelFilePolicy(target.surface);
  if (!policy) throw new Error(`${target.surface} 渠道不支持显式发送渠道文件`);
  try {
    policy.validate(bytes, mediaType);
  } catch {
    if (target.surface === "telegram") throw new Error("Telegram 文件上限 50,000,000 字节；video 仅 MP4，voice 仅 Ogg/Opus，不自动转码");
    if (target.surface === "weixin") throw new Error("微信文件上限 25 MiB；video 仅 MP4；暂不支持原生 voice，可显式选择 file 发送音频文件");
    throw new Error(target.surface === "feishu"
      ? "飞书文件上限 30,000,000 字节；video 仅支持 MP4，voice 仅支持 Ogg/Opus，不自动转码"
      : "QQ 普通文件上限 64 MiB；video 仅支持 MP4、上限 30,000,000 字节，voice 仅支持 SILK、上限 20,000,000 字节");
  }
  const pendingDirectory = join(runtime.spoolDirectory, "pending");
  try {
    ensurePrivateDirectorySync(runtime.spoolDirectory);
    ensurePrivateDirectorySync(pendingDirectory);
  } catch {
    throw new Error("渠道文件暂存目录不是可访问的当前用户私有目录");
  }
  const base = randomUUID();
  const pendingFile = join(pendingDirectory, `${base}.bin`);
  const manifestPath = join(pendingDirectory, `${base}.json`);
  const stagedManifestPath = join(pendingDirectory, `.${base}.pending`);
  try {
    writePrivateFileAtomicSync(pendingFile, bytes);
    writePrivateFileAtomicSync(stagedManifestPath, `${JSON.stringify({
      version: 1, threadId: resolvedThreadId, filePath: pendingFile, fileName, mediaType, createdAtMs: now(),
    }, null, 2)}\n`);
    renameSync(stagedManifestPath, manifestPath);
  } catch {
    try { rmSync(stagedManifestPath, { force: true }); } catch { /* Retain task-owned staging when cleanup is unavailable. */ }
    try { rmSync(pendingFile, { force: true }); } catch { /* A manifest was never published. */ }
    throw new Error("渠道文件暂存发布失败，请检查私有目录访问权限");
  }
  return { manifestPath, filePath: pendingFile, fileName, mediaType, threadId: resolvedThreadId, target, spoolDirectory: runtime.spoolDirectory };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
      console.log(`${CHANNEL_SEND_FILE_USAGE}\n\n通过现有前台或后台 Thread 绑定，把本机文件交给 Gateway 发送。支持 QQ、飞书、Telegram、微信。\nQQ：默认 file 上限 64 MiB；video 为 MP4、上限 30,000,000 字节；voice 为 SILK、上限 20,000,000 字节。\n飞书：file/video/voice 均上限 30,000,000 字节；video 为 MP4，voice 为 Ogg/Opus。\nTelegram：三类上限 50,000,000 字节，video 为 MP4，voice 为 Ogg/Opus。\n微信：file/video 上限 25 MiB，video 为 MP4；原生 voice 不支持，可显式选 file 发送音频文件。\n媒体类型须显式选择，按内容校验，不按后缀推断、不自动转码；拒绝空文件和符号链接；不指定 --thread 时须仅有一个绑定。`);
    } else {
      const result = await submitChannelFile(parseChannelSendFileArgs(args));
      writeCliMessage("success", "已提交渠道文件发送，网关确认发送后自动归档。");
      console.log(`Thread：${result.threadId}`);
      console.log(`渠道：${result.target.surface}（${result.target.conversationId}）`);
      console.log(`文件：${result.fileName}`);
      console.log(`类型：${result.mediaType}`);
      console.log(`失败保留：${join(result.spoolDirectory, "failed")}`);
    }
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : "渠道文件发送失败");
    process.exitCode = 1;
  }
}
