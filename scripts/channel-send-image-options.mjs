import { isAbsolute } from "node:path";

export const CHANNEL_SEND_IMAGE_USAGE = "用法：codexc channel send-image <图片路径> [--thread <Thread ID>] [--format image|markdown]";

export function assertAbsoluteChannelImagePath(value) {
  if (!isAbsolute(value)) {
    throw new Error("图片路径必须是绝对路径");
  }
}

export function parseChannelSendImageArgs(args) {
  let threadId;
  let format;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--format") {
      if (format !== undefined) throw new Error("--format 只能指定一次");
      format = args[++index];
      if (format !== "image" && format !== "markdown") throw new Error("--format 只支持 image 或 markdown");
      continue;
    }
    if (args[index] === "--thread") {
      if (threadId !== undefined) throw new Error("--thread 只能指定一次");
      threadId = args[index + 1];
      if (!threadId || threadId.startsWith("--")) {
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
    throw new Error(CHANNEL_SEND_IMAGE_USAGE);
  }
  assertAbsoluteChannelImagePath(positional[0]);
  return { imagePath: positional[0], threadId, format: format ?? "image" };
}
