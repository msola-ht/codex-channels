import * as clackPrompts from "@clack/prompts";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readGatewayConfig, validateGatewayConfigStructureDocument } from "../runtime/gateway-config.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { securePrivateDirectorySync } from "../runtime/private-file.mjs";
import { packageDir } from "./package-path.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";
import { userDataDir } from "./runtime-config.mjs";
import { videoConfiguration } from "./video-analysis-client.mjs";

const cancelled = Symbol("cancelled");
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const clean = value => typeof value === "string" && !/[\0\r\n]/u.test(value);
const required = value => clean(value) && value.trim() ? undefined : "请输入非空单行文本";
const positive = value => /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? undefined : "请输入正整数秒数";

// Local videos are read from anywhere on this host, so the operator never picks a directory.
const localVideoScope = "any";

/**
 * Gateway-owned channel attachment directory beside the StateStore database; derived from
 * configuration without creating it before the operator confirms saving.
 */
function strataChannelRoot({ environment, dataDir, configPath }) {
  const path = resolve(configPath ?? (environment.CODEX_CONNECT_CONFIG_FILE?.trim()
    || join(dataDir ?? userDataDir(environment), "config.toml")));
  try {
    const document = validateGatewayConfigStructureDocument(readGatewayConfig(path));
    // Match Gateway: schema supplies the default; preserve spaces in path values.
    const stateDatabasePath = resolve(dirname(path), document.storage.database_path);
    return join(dirname(stateDatabasePath), "uploads", "video");
  } catch (error) {
    throw new Error("无法读取或校验 Gateway 配置，未确定渠道附件目录；请先检查当前配置，未写入 MCP", { cause: error });
  }
}

function prepareStrataChannelRoot(root) {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
      throw new Error("渠道附件目录必须是当前用户拥有的非链接目录");
    }
    securePrivateDirectorySync(root);
  } catch (error) {
    throw new Error(`无法准备渠道附件目录 ${root}；请检查目录类型、所有者和权限，未写入 MCP`, { cause: error });
  }
}

function jsonValue(text, kind) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("请输入合法 JSON，不回显输入内容"); }
  if (kind === "args" || kind === "env_vars") {
    if (!Array.isArray(value) || !value.every(item => clean(item) && (kind === "args" || envName.test(item)))
        || (kind === "env_vars" && new Set(value).size !== value.length)) {
      throw new Error(kind === "args" ? "参数须为字符串 JSON 数组" : "请输入不重复的环境变量名 JSON 数组");
    }
  } else {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !Object.entries(value).every(([key, item]) => clean(item)
          && (kind === "env" ? envName.test(key) : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key))
          && (kind !== "http_headers" || [...item].every(character => {
            const code = character.charCodeAt(0);
            return code === 9 || (code >= 32 && code !== 127);
          }))
          && (kind !== "env_http_headers" || envName.test(item)))) {
      throw new Error("请输入名称到合法单行字符串值的 JSON 对象；HTTP Header 不接受非法控制字符");
    }
  }
  return value;
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    if (clean(value) && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash) return;
  } catch { /* Return a safe validation message. */ }
  return "请输入 http(s) 地址，不含内嵌用户名、密码或片段";
}

/** Add one user-owned server; never replace existing or plugin configuration. */
export async function runMcpSetup({ environment = process.env, dataDir, configPath, output = process.stdout,
  prompts = clackPrompts, createClient = createCodexUserConfigClient } = {}) {
  const ask = async (method, options) => {
    const value = await prompts[method](options);
    if (prompts.isCancel(value)) throw cancelled;
    if (options.validate) {
      const error = options.validate(value);
      if (error) throw new Error(error);
    }
    return value;
  };
  const text = (message, initialValue = "", validate = required) => ask("text", { message, initialValue, validate });
  const json = async (message, kind, secret = false) => {
    const value = await ask(secret ? "password" : "text", { message,
      ...(secret ? {} : { initialValue: kind === "args" || kind === "env_vars" ? "[]" : "{}" }),
      validate: input => { try { jsonValue(input || "{}", kind); } catch (error) { return error.message; } },
    });
    return jsonValue(value || "{}", kind);
  };
  let client;
  try {
    const kind = await ask("select", { message: "新增 MCP 类型", options: [
      { value: "strata", label: "Strata 视频分析预设" },
      { value: "stdio", label: "本地命令（stdio）" },
      { value: "http", label: "远程服务（Streamable HTTP）" },
      { value: "back", label: "返回" },
    ] });
    if (kind === "back") return { action: "back" };
    if (!["strata", "stdio", "http"].includes(kind)) throw new Error("不支持的 MCP 类型");
    let snapshot;
    try {
      client = await createClient({ environment });
      await client.connect();
      snapshot = await client.readUserConfigSnapshot();
    } catch {
      throw new Error("无法读取 Codex 用户配置；请检查 CLI 与配置是否可用，未写入 MCP");
    }
    const name = kind === "strata" ? "strata_video" : await text("MCP 名称（字母、数字、下划线、连字符）", "",
      value => /^[A-Za-z0-9_-]+$/u.test(value) ? undefined : "名称只接受字母、数字、下划线、连字符");
    if ([snapshot.config, snapshot.toolConfig].some(config => Object.hasOwn(config?.mcp_servers ?? {}, name)
      || Object.values(config?.plugins ?? {}).some(plugin => Object.hasOwn(plugin?.mcp_servers ?? {}, name)))) {
      throw new Error("同名 MCP 已存在；请使用新名称，已有条目的策略在电脑、浏览器与 MCP 菜单管理");
    }
    let server;
    if (kind === "strata") {
      const env = {
        STRATA_VIDEO_BASE_URL: await text("Strata 服务根地址（不含 /v1）", "", httpUrl),
        STRATA_VIDEO_MODEL: await text("Strata 模型 ID"),
        STRATA_VIDEO_API_KEY: await ask("password", { message: "Strata API Key（写入用户配置，不回显）", validate: required }),
        STRATA_VIDEO_ROOT: localVideoScope,
        STRATA_VIDEO_CHANNEL_ROOT: strataChannelRoot({ environment, dataDir, configPath }),
      };
      env.STRATA_VIDEO_TRANSPORT = await ask("select", { message: "Strata 视频传输方式", options: [
        { value: "files", label: "文件引用（默认；需要启用 video_files，追问复用上传）" },
        { value: "url", label: "旧版兼容（每次完整发送视频，无预处理缓存）" },
      ] });
      const seconds = await text("视频分析总时限（1–1800 秒）", "900", value => positive(value) ?? (Number(value) > 1800 ? "最大 1800 秒" : undefined));
      env.STRATA_VIDEO_TIMEOUT_SECONDS = seconds;
      // Validate service settings now; the attachment directory is prepared only after confirmation.
      await videoConfiguration({ ...env, STRATA_VIDEO_CHANNEL_ROOT: undefined });
      server = { command: process.execPath, args: [join(packageDir, "scripts", "video-analysis-mcp.mjs")], env,
        tool_timeout_sec: Number(seconds) + 60 };
    } else if (kind === "stdio") {
      server = { command: await text("可执行文件或绝对路径（参数在下一步输入，不使用 Shell 拆分）"),
        args: await json('启动参数 JSON 数组，例如 ["-y","package-name"]；不要在参数中放密钥', "args") };
      const cwd = await text("工作目录（绝对路径；留空使用 Codex 默认值）", "", value => !value || isAbsolute(value) ? undefined : "请输入绝对路径或留空");
      if (cwd) server.cwd = cwd;
      server.env = await json("环境变量 JSON 对象（隐藏输入；留空为 {}；值写入用户配置）", "env", true);
      server.env_vars = await json("从宿主继承的环境变量名 JSON 数组", "env_vars");
    } else {
      server = { url: await text("MCP HTTP URL", "", httpUrl) };
      const bearer = await text("Bearer Token 的宿主环境变量名（不是 Token；无则留空）", "", value => !value || envName.test(value) ? undefined : "请输入环境变量名或留空");
      if (bearer) server.bearer_token_env_var = bearer;
      server.http_headers = await json("固定 HTTP Headers JSON 对象（隐藏输入；留空为 {}）", "http_headers", true);
      server.env_http_headers = await json("从环境变量读取 Header 的 JSON 对象，例如 {\"X-Key\":\"API_KEY\"}", "env_http_headers");
    }
    server.startup_timeout_sec = Number(await text("MCP 启动超时（秒）", "10", positive));
    if (kind !== "strata") server.tool_timeout_sec = Number(await text("MCP 调用超时（秒）", "60", positive));
    server.enabled = await ask("confirm", { message: "保存后启用此 MCP？", initialValue: true });
    // Do not print launch arguments, URL queries, header values or environment values.
    output.write(`写入：${join(codexHomePath(environment), "config.toml")}\n作用范围：该 Codex Home 的用户配置\nMCP：${name}；类型：${kind}；启用：${server.enabled}\n启动超时：${server.startup_timeout_sec} 秒；调用超时：${server.tool_timeout_sec} 秒\n`);
    if (kind === "strata") output.write(`本机视频范围：任意本机绝对路径（STRATA_VIDEO_ROOT=${server.env.STRATA_VIDEO_ROOT}；任何可使用此 MCP 的会话都能指定本机视频路径）\n渠道附件目录（确认后创建并设置私有权限）：${server.env.STRATA_VIDEO_CHANNEL_ROOT}\n视频传输：${server.env.STRATA_VIDEO_TRANSPORT}\n思考默认 medium；可选 none、low、medium、xhigh；预算由 Strata 管理。\n`);
    output.write("参数、环境变量与 Header 值不回显；密钥值将保存在用户配置中。继承变量须由实际启动 Codex 的环境提供。\n");
    output.write("未读取插件清单；请使用独立名称，用户配置中的同名 MCP 会优先于插件服务器。\n");
    if (await ask("confirm", { message: "确认新增并保存上述 MCP？", initialValue: false }) !== true) return { action: "back" };
    if (kind === "strata") {
      if (strataChannelRoot({ environment, dataDir, configPath }) !== server.env.STRATA_VIDEO_CHANNEL_ROOT) {
        throw new Error("Gateway 渠道附件目录已变化，未写入 MCP；请重新进入菜单核对目录");
      }
      prepareStrataChannelRoot(server.env.STRATA_VIDEO_CHANNEL_ROOT);
      await videoConfiguration(server.env);
    }
    try {
      await client.writeUserConfigEdits([{ keyPath: `mcp_servers.${name}`, value: server }], { expectedVersion: snapshot.version });
    } catch (error) {
      if (error?.data?.config_write_error_code === "configVersionConflict") {
        throw new Error("Codex 用户配置已变化，未保存此 MCP；请重新进入菜单读取最新配置", { cause: error });
      }
      throw new Error("MCP 配置保存未确认；可能存在配置冲突或写入错误。请重新读取配置后处理，不自动重试。", { cause: error });
    }
    output.write("MCP 配置已保存。新会话或重新加载 MCP 后使用；已有连接不保证立即更新，未自动重启服务。\n");
    return { action: "added", name };
  } catch (error) {
    if (error === cancelled) return { action: "back" };
    throw error;
  } finally { await client?.close().catch(() => undefined); }
}
