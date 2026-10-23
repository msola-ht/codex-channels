import { isAbsolute, resolve } from "node:path";

export const TRAFFIC_USAGE = `用法：codexc traffic [选项] [V2 session 目录]

把自有代理或可选 Relay 生成的 V2 转储渲染成人可读文本：每次逻辑模型调用只展示一条请求
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

不传路径时读取 --dir 下最新标签、最新 writer session。位置参数只接受一个 V2 session 目录。
--follow 从当前末尾开始，显式传入 session 时从已有调用开始输出。
默认跟随锁定首次选中的标签，依次读取该标签的新批次，并继续等待旧批次中已观察到的未终态调用。
轮转后仍按标签、批次与编号输出；批次或调用缺失会明确报告，不跨标签关联。
跟随保留旧批次游标，以接收轮转后才写入的请求；同号调用的重复请求记录不会重复输出。
跟随最多保留 2048 个批次、2000000 个已观察编号和 100000 个未终态调用，超限请缩小范围重新跟随。
只保存标识和文件水位，不缓存正文；目录或索引被替换会明确失败。
交互与 trace 共用 256 项索引缓存；缓存回收后重建也会停止跟随，需选择较小范围重新开始。
索引每次最多等待 35 秒；诊断未完成会明确标记，不表示未发生。
每次读取共用 128 MiB、10 万记录和 10 秒预算，大正文自动缩小摘要页；单条仍超限会明确失败。

清理使用 codexc cleanup traffic -h 查看预览与确认删除的要求。`;

export const TRAFFIC_CLEANUP_USAGE = `用法：codexc cleanup traffic [--dir 目录] [--confirm] [--expected-fingerprint 指纹]

预览或清空转储目录中可识别的全部 V2 session。默认只预览；加 --confirm 才会
删除，删除前必须停止全部 App Server 与 Relay。未知文件和目录不会删除。

选项：
  --dir <目录>         指定预览目录；确认删除只允许当前配置的数据目录下的 traffic
  --confirm            确认永久删除预览范围内的全部转储
  --expected-fingerprint <SHA-256>  仅清理与已确认预览完全一致的范围
  -h, --help           显示本帮助`;

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
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith("--")) {
      if (seen.has(argument)) throw new Error(`${argument} 不能重复`);
      seen.add(argument);
    }
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
  if (options.files.length > 1) throw new Error("只能指定一个 V2 session 目录");
  return options;
}

export function parseTrafficCleanupArgs(args) {
  const options = { confirm: false, directory: undefined, expectedFingerprint: undefined };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error(`${argument} 不能重复`);
    seen.add(argument);
    if (argument === "--confirm") {
      options.confirm = true;
      continue;
    }
    if (argument === "--dir") {
      options.directory = resolve(requiredValue(args[index + 1], "--dir"));
      index += 1;
      continue;
    }
    if (argument === "--expected-fingerprint") {
      const value = requiredValue(args[index + 1], argument);
      if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("清理预览指纹必须是 SHA-256");
      options.expectedFingerprint = value;
      index += 1;
      continue;
    }
    throw new Error(`未知清理参数：${argument}`);
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
  if (raw === undefined || raw.length === 0 || raw.startsWith("-")) {
    throw new Error(`${name} 缺少值`);
  }
  return raw;
}
