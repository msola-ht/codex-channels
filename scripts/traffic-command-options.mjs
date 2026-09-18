import { isAbsolute, resolve } from "node:path";

export const TRAFFIC_USAGE = `用法：codexc traffic [选项] [V2 session 目录]

把 [debug].model_traffic_dump 生成的 V2 转储渲染成人可读文本：每次逻辑模型调用只展示一条请求
和一个终态响应，原始 SSE 事件与 WebSocket 帧保留在独立 trace 中。

默认列出模型调用摘要；展开正文需要 --exchange 或 --all。

选项：
  --list               只列出模型调用摘要（默认行为）
  --all                展开所有模型调用的请求与终态响应
  --exchange <编号>    只显示指定模型调用（正整数）
  --grep <文本>        只显示包含该文本的模型调用
  --max-bytes <字节>   每段正文最多显示多少字节，默认不截断
  --follow             持续输出新写入的转储内容，按 Ctrl-C 停止
  --dir <目录>         指定转储目录，默认当前用户数据目录下的 traffic
  -h, --help           显示本帮助

不传路径时读取 --dir 下最新标签、最新 writer session。位置参数只接受一个 V2 session 目录；旧版逐帧
JSONL 不自动迁移或混读。--follow 从当前末尾开始，显式传入 session 时从已有调用开始输出。`;

export function parseTrafficCommandArgs(args) {
  const options = {
    all: false,
    directory: undefined,
    exchange: undefined,
    files: [],
    follow: false,
    grep: undefined,
    list: false,
    maxBytes: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--all") {
      options.all = true;
      continue;
    }
    if (argument === "--list") {
      options.list = true;
      continue;
    }
    if (argument === "--follow") {
      options.follow = true;
      continue;
    }
    if (argument === "--exchange") {
      options.exchange = positiveInteger(args[index + 1], "--exchange");
      index += 1;
      continue;
    }
    if (argument === "--max-bytes") {
      options.maxBytes = nonNegativeInteger(args[index + 1], "--max-bytes");
      index += 1;
      continue;
    }
    if (argument === "--grep") {
      options.grep = requiredValue(args[index + 1], "--grep");
      index += 1;
      continue;
    }
    if (argument === "--dir") {
      const value = requiredValue(args[index + 1], "--dir");
      options.directory = resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`未知参数：${argument}`);
    }
    const file = requiredValue(argument, "V2 session 目录");
    options.files.push(isAbsolute(file) ? file : resolve(file));
  }
  if (options.all && options.list) {
    throw new Error("--list 与 --all 不能同时使用");
  }
  return options;
}

function positiveInteger(raw, name) {
  return boundedInteger(raw, name, "正整数值", 1);
}

function nonNegativeInteger(raw, name) {
  return boundedInteger(raw, name, "非负整数值", 0);
}

/** `-1` 这类负数是非法取值，`--all` 这类以 `-` 开头的才是缺少值，两者提示不同。 */
function boundedInteger(raw, name, description, minimum) {
  if (raw === undefined || (raw.startsWith("-") && !/^-[0-9]+$/u.test(raw))) {
    throw new Error(`${name} 缺少值`);
  }
  const value = Number(raw);
  if (!/^-?[0-9]+$/u.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} 需要${description}`);
  }
  return value;
}

function requiredValue(raw, name) {
  if (raw === undefined || raw.startsWith("-")) {
    throw new Error(`${name} 缺少值`);
  }
  return raw;
}
