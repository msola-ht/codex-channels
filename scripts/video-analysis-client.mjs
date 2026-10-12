import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Agent, request } from "undici";

const maximumVideoBytes = 64 * 1024 * 1024;
const maximumResponseBytes = 2 * 1024 * 1024;
const mimeTypes = new Map([
  [".mp4", "video/mp4"], [".mov", "video/quicktime"],
  [".webm", "video/webm"], [".mkv", "video/x-matroska"],
  [".avi", "video/x-msvideo"], [".ts", "video/mp2t"],
]);

export class VideoAnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new VideoAnalysisError(code, message);
}

export async function videoConfiguration(environment) {
  let endpoint;
  try { endpoint = new URL(environment.STRATA_VIDEO_BASE_URL); }
  catch { fail("configuration", "STRATA_VIDEO_BASE_URL 必须是服务根地址。"); }
  if (!["http:", "https:"].includes(endpoint.protocol)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== "/") {
    fail("configuration", "STRATA_VIDEO_BASE_URL 只接受 http(s) 服务根地址，不含凭据、路径或查询参数。");
  }
  const apiKey = environment.STRATA_VIDEO_API_KEY;
  const model = environment.STRATA_VIDEO_MODEL;
  if (!apiKey || /[\r\n]/u.test(apiKey) || !model?.trim() || model.length > 200) {
    fail("configuration", "必须设置有效的 STRATA_VIDEO_API_KEY 和 STRATA_VIDEO_MODEL。");
  }
  const configuredRoot = environment.STRATA_VIDEO_ROOT;
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    fail("configuration", "STRATA_VIDEO_ROOT 必须是已存在目录的绝对路径。");
  }
  let root;
  try {
    root = await realpath(configuredRoot);
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch { fail("configuration", "STRATA_VIDEO_ROOT 不是可用目录。"); }
  const timeoutText = environment.STRATA_VIDEO_TIMEOUT_SECONDS ?? "900";
  if (!/^\d+$/u.test(timeoutText) || Number(timeoutText) < 1 || Number(timeoutText) > 1800) {
    fail("configuration", "STRATA_VIDEO_TIMEOUT_SECONDS 必须是 1–1800 的整数。");
  }
  return { endpoint: new URL("v1/responses", endpoint), apiKey, model, root,
    timeoutMs: Number(timeoutText) * 1000 };
}

export const videoTool = {
  name: "analyze_video",
  description: "将指定视频发送给管理员配置的 Strata 模型并返回分析文字。video 接受授权目录直属文件名，或该目录及子目录内的本机绝对路径，不接受 URL。只分析画面，不分析音轨；每次调用独立，追问须再次指定视频。",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["video", "question"],
    properties: {
      video: { type: "string", minLength: 1, maxLength: 4096, description: "授权目录直属文件名（最多 255 字符），或目录及子目录内的本机绝对路径（最多 4096 字符）。路径属于 MCP 所在主机。" },
      question: { type: "string", minLength: 1, maxLength: 16000, description: "视频分析问题；可要求按时间顺序描述并标出时间戳。" },
      max_output_tokens: { type: "integer", minimum: 64, maximum: 4096, default: 1024 },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

function validateArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).some((key) => !["video", "question", "max_output_tokens"].includes(key))
      || typeof args.video !== "string" || !args.video || args.video.length > 4096
      || [...args.video].some((character) => character.charCodeAt(0) < 32)
      || typeof args.question !== "string" || !args.question.trim() || args.question.length > 16000
      || (args.max_output_tokens !== undefined && (!Number.isInteger(args.max_output_tokens)
        || args.max_output_tokens < 64 || args.max_output_tokens > 4096))) {
    fail("invalid_arguments", "需要 video 文件名或本机绝对路径和非空 question；max_output_tokens 为 64–4096 的整数，不接受其他参数。");
  }
  const mime = mimeTypes.get(extname(args.video).toLowerCase());
  if (!mime) fail("unsupported_video", "只接受 mp4、mov、webm、mkv、avi、ts 视频文件。");
  return mime;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readVideo(root, name, signal) {
  const absolute = isAbsolute(name);
  // Reject traversal before normalization, Windows device/UNC paths and ADS.
  // On POSIX, backslashes and colons are deliberately outside this contract.
  if (name.split(/[/\\]/u).some((part) => part === "." || part === "..")
      || (absolute && (process.platform === "win32"
        ? !/^[a-z]:[/\\]/iu.test(name) || name.slice(2).includes(":")
        : /[\\:]/u.test(name)))
      || (!absolute && (name.length > 255 || /[/\\:]/u.test(name)))) {
    fail("invalid_arguments", "video 只接受直属文件名或本机绝对路径，不接受相对路径、URL、点路径或设备路径。");
  }
  const path = absolute ? resolve(name) : join(root, name);
  const withinRoot = relative(root, path);
  if (!withinRoot || isAbsolute(withinRoot) || withinRoot === ".." || withinRoot.startsWith(`..${sep}`)) {
    fail("unsafe_file", "视频路径必须位于 STRATA_VIDEO_ROOT 授权目录内。");
  }
  let handle;
  try {
    signal.throwIfAborted();
    if (await realpath(path) !== path) {
      fail("unsafe_file", "视频路径及其子目录不能包含链接；请使用授权目录内的真实路径。");
    }
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1) {
      fail("unsafe_file", "视频必须是普通文件，不能是链接、目录或设备。");
    }
    if (before.size < 1 || before.size > maximumVideoBytes) {
      fail("video_size", "视频必须为 1 字节至 64 MiB；不会自动截断或压缩。");
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened) || await realpath(path) !== path) {
      fail("unsafe_file", "读取前视频文件发生变化或包含链接。");
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!bytesRead) fail("file_changed", "视频在读取过程中被截断。");
      offset += bytesRead;
    }
    if (!sameFile(opened, await handle.stat()) || !sameFile(opened, await lstat(path))) {
      fail("file_changed", "视频在读取过程中发生变化，请停止写入后重试。");
    }
    signal.throwIfAborted();
    return bytes;
  } catch (error) {
    if (signal.aborted || error instanceof VideoAnalysisError) throw error;
    fail("file_unavailable", "无法读取授权目录中的视频文件。");
  } finally { await handle?.close(); }
}

export async function analyzeVideo(config, args, signal) {
  const mime = validateArguments(args);
  const bytes = await readVideo(config.root, args.video, signal);
  signal.throwIfAborted();
  // The same signal must also cancel a socket still in DNS/TCP/TLS setup;
  // aborting only request() leaves Agent.destroy() waiting for connect timeout.
  const dispatcher = new Agent({ connections: 1, connect: { signal, timeout: Math.min(10_000, config.timeoutMs) } });
  try {
    const response = await request(config.endpoint, {
      dispatcher, method: "POST", signal, maxRedirections: 0,
      headersTimeout: config.timeoutMs, bodyTimeout: config.timeoutMs,
      headers: { "content-type": "application/json", accept: "application/json",
        authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, stream: false,
        max_output_tokens: args.max_output_tokens ?? 1024,
        input: [{ role: "user", content: [
          { type: "input_text", text: args.question },
          { type: "input_video", video_url: `data:${mime};base64,${bytes.toString("base64")}` },
        ] }] }),
    });
    if (response.statusCode !== 200) {
      // Undici emits an error when an unconsumed body is destroyed. Handle
      // that deliberate abort without exposing the upstream error body.
      response.body.on("error", () => {});
      response.body.destroy();
      fail("upstream_http", `Strata 返回 HTTP ${response.statusCode}；请在服务端检查认证、视频启用状态和资源限制。`);
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers["content-type"] ?? "")) {
      response.body.on("error", () => {});
      response.body.destroy();
      fail("upstream_format", "Strata 未返回请求的 JSON 响应。");
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximumResponseBytes) fail("response_size", "Strata 响应超过 2 MiB 限制。");
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { fail("upstream_format", "Strata 返回了无效 JSON。"); }
    if (result?.status !== "completed") {
      fail("upstream_incomplete", "Strata 未完成视频分析（可能输出额度不足或生成失败）；不把部分内容当作成功结果。");
    }
    if (!Array.isArray(result.output)) fail("upstream_format", "Strata 响应缺少 output。");
    const text = result.output.filter((item) => item?.type === "message" && item.role === "assistant")
      .flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .filter((part) => part?.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text).join("\n");
    if (!text.trim()) fail("empty_result", "Strata 完成响应中没有可用的分析文字。");
    if (text.includes(config.apiKey)) fail("sensitive_result", "上游分析内容包含服务凭据，已拒绝返回。");
    signal.throwIfAborted();
    return { video: args.video, analysis: text, audio_analyzed: false };
  } catch (error) {
    if (signal.aborted || error instanceof VideoAnalysisError) throw error;
    fail("upstream_transport", "无法完成 Strata 请求：网络错误或响应体中断。");
  } finally { await dispatcher.destroy(); }
}
