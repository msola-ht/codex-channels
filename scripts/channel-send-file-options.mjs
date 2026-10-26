import { isAbsolute } from "node:path";

export const CHANNEL_SEND_FILE_USAGE = "用法：codexc channel send-file <绝对文件路径> [--type file|video|voice] [--thread <Thread ID>]";

export function parseChannelSendFileArgs(args) {
  let threadId;
  let mediaType;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--thread") {
      if (threadId !== undefined) throw new Error("--thread 只能指定一次");
      threadId = args[++index];
      if (!threadId || threadId.startsWith("-")) throw new Error("--thread 缺少值");
    } else if (value === "--type") {
      if (mediaType !== undefined) throw new Error("--type 只能指定一次");
      mediaType = args[++index];
      if (mediaType !== "file" && mediaType !== "video" && mediaType !== "voice") {
        throw new Error("--type 必须是 file、video 或 voice");
      }
    } else if (value.startsWith("-")) {
      throw new Error(`未知参数：${value}`);
    } else positional.push(value);
  }
  if (positional.length !== 1) throw new Error(CHANNEL_SEND_FILE_USAGE);
  if (!isAbsolute(positional[0])) throw new Error("文件路径必须是绝对路径");
  return { filePath: positional[0], threadId, mediaType: mediaType ?? "file" };
}
