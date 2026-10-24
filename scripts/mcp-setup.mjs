import * as clackPrompts from "@clack/prompts";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readGatewayConfig, validateGatewayConfigStructureDocument } from "../runtime/gateway-config.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { securePrivateDirectorySync } from "../runtime/private-file.mjs";
import { createCodexUserConfigClient, withCodexUserConfigClient } from "./codex-user-config.mjs";
import { userDataDir } from "./runtime-config.mjs";
import { videoConfiguration } from "./video-analysis-client.mjs";
import { isStrataServer, mcpToolApprovalModes, validateStrataMcpEdit } from "./codex-tool-settings.mjs";

const cancelled = Symbol("cancelled");
const approvalLabels = {
  auto: "按工具属性判断（auto）",
  prompt: "每次调用询问（prompt）",
  writes: "非只读工具询问（writes）",
  approve: "免除此层工具审批（approve）",
};

async function askMcpApproval(ask, current, output) {
  if (current !== undefined && !mcpToolApprovalModes.includes(current)) {
    throw new Error("现有 MCP 工具审批模式不受支持，请通过原生配置核对，未保存");
  }
  output.write("此设置是 MCP 服务器的默认工具审批策略；已有单工具覆盖及其他权限限制继续生效。\n");
  const value = await ask("select", { message: "MCP 工具调用审批", initialValue: current ?? "inherit", options: [
    { value: "inherit", label: "跟随其他配置来源或默认值（不设置用户覆盖）" },
    ...mcpToolApprovalModes.map(mode => ({ value: mode, label: approvalLabels[mode] })),
  ] });
  if (value === "inherit") return null;
  if (!mcpToolApprovalModes.includes(value)) throw new Error("不支持的 MCP 工具审批模式，未保存");
  return value;
}
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const clean = value => typeof value === "string" && !/[\0\r\n]/u.test(value);
const required = value => clean(value) && value.trim() ? undefined : "请输入非空单行文本";
const positive = value => /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? undefined : "请输入正整数秒数";

// Local videos are read from anywhere on this host, so the operator never picks a directory.
const localVideoScope = "any";
const mcpTypes = [
  { value: "strata", label: "Strata 视频分析预设", name: "strata_video" },
  { value: "anysearch", label: "AnySearch 搜索预设", name: "anysearch" },
  { value: "stdio", label: "本地命令（stdio）" },
  { value: "http", label: "远程服务（Streamable HTTP）" },
];

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
    if (["http_headers", "env_http_headers"].includes(kind)
        && new Set(Object.keys(value).map(key => key.toLowerCase())).size !== Object.keys(value).length) {
      throw new Error("HTTP Header 名称不可使用不同大小写重复设置");
    }
  }
  return value;
}

function httpAuthenticationError(server) {
  const sources = Number(Boolean(server.bearer_token_env_var))
    + ["http_headers", "env_http_headers"].reduce((count, group) => count
      + Object.keys(server[group] ?? {}).filter(key => key.toLowerCase() === "authorization").length, 0);
  return sources > 1 ? "HTTP 认证来源冲突；Bearer 环境变量、固定 Authorization 与环境变量 Authorization 只能选择一种" : undefined;
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    if (clean(value) && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash) return;
  } catch { /* Return a safe validation message. */ }
  return "请输入 http(s) 地址，不含内嵌用户名、密码或片段";
}

async function saveMcpEdits(client, snapshot, edits, output) {
  try {
    await client.writeUserConfigEdits(edits.map(({ path, value }) => ({
      keyPath: path.map(part => `"${part.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join("."), value,
    })), { expectedVersion: snapshot.version });
  } catch (error) {
    if (error?.data?.config_write_error_code === "configVersionConflict") {
      throw new Error("Codex 用户配置已变化，未保存此 MCP；请重新进入菜单读取最新配置", { cause: error });
    }
    throw new Error("MCP 配置保存未确认；请重新读取配置后处理，不自动重试。", { cause: error });
  }
  try {
    const current = await client.readUserConfigSnapshot();
    for (const { path, value } of edits) {
      const actual = path.reduce((item, key) => item && Object.hasOwn(item, key) ? item[key] : undefined, current.config);
      if (!isDeepStrictEqual(actual, value === null ? undefined : value)) throw new Error("配置回读不一致");
    }
    const authenticationEdits = edits.filter(({ path, value }) => (path.length === 2 && value !== null)
      || ["http_headers", "env_http_headers", "bearer_token_env_var"].includes(path[2]));
    for (const name of new Set(authenticationEdits.map(({ path }) => path[1]))) {
      const effective = current.toolConfig?.mcp_servers?.[name];
      if (effective?.url && httpAuthenticationError(effective)) {
        throw new Error("合并配置仍有冲突认证来源");
      }
    }
  } catch (error) {
    throw new Error("用户配置写入已返回，但回读或合并认证检查未通过；其他来源的认证可能重新生效，请通过原生配置核对，不自动回滚或重试。", { cause: error });
  }
  output.write("MCP 配置已保存并回读确认。新会话或重新加载 MCP 后使用；已有连接不保证立即更新，未自动重启服务。\n");
}

function authCleanupEdits(path, server, keepGroup, keepHeader) {
  const edits = keepGroup === "bearer_token_env_var" ? [] : [{ path: [...path, "bearer_token_env_var"], value: null }];
  for (const group of ["http_headers", "env_http_headers"]) {
    for (const header of Object.keys(server[group] ?? {})) {
      if (header.toLowerCase() === "authorization" && (group !== keepGroup || (keepHeader && header !== keepHeader))) {
        edits.push({ path: [...path, group, header], value: null });
      }
    }
  }
  return edits;
}

async function manageExistingMcp({ operation, snapshot, client, ask, apiKey, environment, output }) {
  const servers = snapshot.config.mcp_servers ?? {};
  const names = Object.keys(servers).sort();
  if (!names.length) {
    output.write("当前 Codex Home 用户配置中没有 MCP；插件及其他配置来源不在此编辑或删除。\n");
    return { action: "back" };
  }
  const selected = await ask("select", { message: `选择要${operation === "edit" ? "编辑" : "删除"}的用户 MCP`,
    options: [...names.map((name, index) => ({ value: index, label: name })), { value: "back", label: "返回" }] });
  if (selected === "back") return { action: "back" };
  if (!Number.isInteger(selected) || selected < 0 || selected >= names.length) throw new Error("请选择已有用户 MCP");
  const name = names[selected];
  const server = servers[name];
  const path = ["mcp_servers", name];
  output.write(`目标：${join(codexHomePath(environment), "config.toml")}\nMCP：${name}；作用范围：仅当前 Codex Home 用户配置\n`);
  let edits;
  let strataEdit;
  if (operation === "delete") {
    output.write("仅删除此用户配置条目，不卸载包、不删除附件或目录。其他配置来源或插件中的同名 MCP 仍可能生效。\n");
    edits = [{ path, value: null }];
  } else {
    if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error("MCP 配置结构无效，请使用 Codex 原生配置修复");
    const fields = [
      { value: "enabled", label: "启用状态" },
      { value: "default_tools_approval_mode", label: "工具调用审批" },
      { value: "startup_timeout_sec", label: "启动超时（秒）" },
      { value: "tool_timeout_sec", label: "调用超时（秒）" },
    ];
    if (typeof server.command === "string") fields.push(
      { value: "command", label: "启动命令" }, { value: "args", label: "启动参数 JSON 数组" },
      { value: "cwd", label: "工作目录" }, { value: "env", label: "环境变量 JSON 对象（整组替换）" },
      { value: "env_vars", label: "继承环境变量 JSON 数组（整组替换）" },
    );
    if (typeof server.url === "string") fields.push(
      { value: "url", label: "服务地址" }, { value: "api_key", label: "API Key（Bearer 认证）" },
      { value: "bearer_token_env_var", label: "Bearer Token 宿主环境变量名" },
      { value: "http_headers", label: "固定 HTTP Headers JSON 对象（整组替换）" },
      { value: "env_http_headers", label: "环境变量 HTTP Headers JSON 对象（整组替换）" },
    );
    if (isStrataServer(server)) fields.push({ value: "strata_key", label: "Strata API Key" });
    const field = await ask("select", { message: "选择要修改的字段（未选字段保留）", options: [...fields, { value: "back", label: "返回" }] });
    if (field === "back") return { action: "back" };
    const descriptor = fields.find(item => item.value === field);
    if (!descriptor) throw new Error("不支持的 MCP 字段");
    const effective = snapshot.toolConfig?.mcp_servers?.[name] ?? server;
    if (["api_key", "bearer_token_env_var", "http_headers", "env_http_headers"].includes(field)
        && (effective.http_headers_helper || effective.auth === "ema_auth")) {
      throw new Error("此 MCP 使用 Header Helper 或企业认证，请通过 Codex 原生配置编辑认证，未保存");
    }
    let value;
    if (field === "api_key" || field === "strata_key") {
      value = await apiKey(field === "strata_key" ? "Strata" : "MCP");
      if (field === "strata_key") edits = [{ path: [...path, "env", "STRATA_VIDEO_API_KEY"], value }];
      else {
        edits = [{ path: [...path, "http_headers", "Authorization"], value: `Bearer ${value}` },
          ...authCleanupEdits(path, server, "http_headers", "Authorization")];
        output.write("将使用直接保存的 Bearer Key，并移除用户层其他 Authorization Header 与 Bearer 环境变量引用。\n");
      }
    } else if (field === "default_tools_approval_mode") {
      value = await askMcpApproval(ask, server.default_tools_approval_mode, output);
    } else if (field === "enabled") {
      value = await ask("confirm", { message: "启用此 MCP？", initialValue: server.enabled !== false });
    } else {
      const removable = !["command", "url"].includes(field);
      const action = await ask("select", { message: descriptor.label, options: [
        { value: "set", label: "设置新值" },
        ...(removable ? [{ value: "remove", label: "移除用户层字段（恢复其他来源或默认值）" }] : []),
        { value: "back", label: "返回" },
      ] });
      if (action === "back") return { action: "back" };
      if (action === "remove" && removable) value = null;
      else if (action === "set") {
        const jsonFields = ["args", "env", "env_vars", "http_headers", "env_http_headers"];
        const validate = input => {
          if (jsonFields.includes(field)) {
            try {
              jsonValue(input, field);
            } catch (error) { return error.message; }
            return;
          }
          if (field.endsWith("_timeout_sec")) return positive(input);
          if (field === "url") return httpUrl(input);
          if (field === "cwd") return clean(input) && isAbsolute(input) ? undefined : "请输入绝对路径";
          if (field === "bearer_token_env_var") return envName.test(input) ? undefined : "请输入环境变量名";
          return required(input);
        };
        const input = await ask("password", { message: `${descriptor.label}：输入新值（隐藏输入，不回填旧值）`, validate });
        value = jsonFields.includes(field) ? jsonValue(input, field) : field.endsWith("_timeout_sec") ? Number(input) : input;
      } else throw new Error("不支持的编辑操作");
    }
    const strata = await validateStrataMcpEdit(snapshot.config, snapshot.toolConfig, name, field, value);
    strataEdit = { field, value };
    if (strata) output.write(`Strata 分析总时限：${strata.timeoutSeconds} 秒；MCP 调用超时：${strata.toolTimeoutSeconds} 秒\n本机视频范围：${strata.root === "any" ? "任意本机绝对路径" : strata.root}\n渠道附件目录：${strata.channelRoot ?? "未配置"}\n`);
    edits ??= [{ path: [...path, field], value }];
    if (value !== null && (field === "bearer_token_env_var"
        || (["http_headers", "env_http_headers"].includes(field) && Object.keys(value).some(key => key.toLowerCase() === "authorization")))) {
      edits.push(...authCleanupEdits(path, server, field));
      output.write("将采用本次设置的认证来源，并移除用户层其他冲突的 Authorization Header 或 Bearer 环境变量引用；引用变量须由 Codex 宿主提供。\n");
    }
    const summary = value === null ? "移除用户层字段" : field === "default_tools_approval_mode" ? approvalLabels[value] : typeof value === "boolean" || typeof value === "number" ? `设置为 ${value}` : "设置新值（隐藏）";
    output.write(`修改字段：${descriptor.label}；${summary}。其余未修改字段与密钥保留。\n`);
    output.write("工具允许/禁用列表和单工具审批覆盖仍在“电脑、浏览器与已有 MCP”管理；其他配置来源可能影响最终生效值。\n");
  }
  if (await ask("confirm", { message: operation === "delete" ? "确认删除上述 MCP 用户配置？" : "确认保存上述 MCP 修改？", initialValue: false }) !== true) return { action: "back" };
  if (strataEdit) {
    const current = await client.readUserConfigSnapshot();
    if (current.version !== snapshot.version
      || !isDeepStrictEqual(current.toolConfig?.mcp_servers?.[name], snapshot.toolConfig?.mcp_servers?.[name])) {
      throw new Error("MCP 用户配置或合并配置已变化，请重新进入菜单确认，未保存");
    }
    await validateStrataMcpEdit(current.config, current.toolConfig, name, strataEdit.field, strataEdit.value);
  }
  await saveMcpEdits(client, snapshot, edits, output);
  return { action: operation === "delete" ? "deleted" : "edited", name };
}

/** Manage user-owned MCP configuration; never modify plugin or other source files. */
export async function runMcpSetup({ environment = process.env, dataDir, configPath, output = process.stdout,
  prompts = clackPrompts, createClient = createCodexUserConfigClient, operation = "add" } = {}) {
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
  const apiKey = label => ask("password", {
    message: `${label} API Key（仅密钥，不含 Bearer 前缀；写入用户配置，不回显）`,
    validate: value => typeof value === "string" && /^[\x21-\x7e]+$/u.test(value)
      ? undefined : "请输入非空 API Key，不含空白、控制字符或 Bearer 前缀",
  });
  const json = async (message, kind, secret = false) => {
    const value = await ask(secret ? "password" : "text", { message,
      ...(secret ? {} : { initialValue: kind === "args" || kind === "env_vars" ? "[]" : "{}" }),
      validate: input => { try { jsonValue(input || "{}", kind); } catch (error) { return error.message; } },
    });
    return jsonValue(value || "{}", kind);
  };
  async function configure(client, kind, type) {
    let snapshot;
    try {
      snapshot = await client.readUserConfigSnapshot();
    } catch {
      throw new Error("无法读取 Codex 用户配置；请检查 CLI 与配置是否可用，未写入 MCP");
    }
    if (operation !== "add") return await manageExistingMcp({ operation, snapshot, client, ask, apiKey, environment, output });
    const name = type.name ?? await text("MCP 名称（字母、数字、下划线、连字符）", "",
      value => /^[A-Za-z0-9_-]+$/u.test(value) ? undefined : "名称只接受字母、数字、下划线、连字符");
    if ([snapshot.config, snapshot.toolConfig].some(config => Object.hasOwn(config?.mcp_servers ?? {}, name)
      || Object.values(config?.plugins ?? {}).some(plugin => Object.hasOwn(plugin?.mcp_servers ?? {}, name)))) {
      throw new Error("同名 MCP 已存在，未覆盖；用户条目可在编辑 MCP 中修改，工具策略在电脑、浏览器与已有 MCP 中管理；如需另建请使用自定义类型和新名称");
    }
    let server;
    if (kind === "strata") {
      const env = {
        STRATA_VIDEO_BASE_URL: await text("Strata 服务根地址（不含 /v1）", "", httpUrl),
        STRATA_VIDEO_MODEL: await text("Strata 模型 ID"),
        STRATA_VIDEO_API_KEY: await apiKey("Strata"),
        STRATA_VIDEO_ROOT: localVideoScope,
        STRATA_VIDEO_CHANNEL_ROOT: strataChannelRoot({ environment, dataDir, configPath }),
        STRATA_VIDEO_TRANSPORT: "files",
        STRATA_VIDEO_TIMEOUT_SECONDS: "900",
      };
      // Validate service settings now; the attachment directory is prepared only after confirmation.
      await videoConfiguration({ ...env, STRATA_VIDEO_CHANNEL_ROOT: undefined });
      server = { command: "strata-video-mcp", args: [], env,
        tool_timeout_sec: Number(env.STRATA_VIDEO_TIMEOUT_SECONDS) + 60 };
    } else if (kind === "anysearch") {
      server = { url: "https://api.anysearch.com/mcp", http_headers: { Authorization: `Bearer ${await apiKey("AnySearch")}` } };
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
    if (server.url) {
      const error = httpAuthenticationError(server);
      if (error) throw new Error(error);
    }
    server = { startup_timeout_sec: 10, tool_timeout_sec: 60, enabled: true, ...server };
    if (!type.name) {
      server.startup_timeout_sec = Number(await text("MCP 启动超时（秒）", String(server.startup_timeout_sec), positive));
      server.tool_timeout_sec = Number(await text("MCP 调用超时（秒）", String(server.tool_timeout_sec), positive));
      server.enabled = await ask("confirm", { message: "保存后启用此 MCP？", initialValue: true });
    }
    const approval = await askMcpApproval(ask, undefined, output);
    if (approval !== null) server.default_tools_approval_mode = approval;
    output.write(`工具调用审批：${approval === null ? "跟随其他配置来源或默认值" : approvalLabels[approval]}\n`);
    // Do not print launch arguments, URL queries, header values or environment values.
    output.write(`写入：${join(codexHomePath(environment), "config.toml")}\n作用范围：该 Codex Home 的用户配置\nMCP：${name}；类型：${type.label}；连接：${server.command ? "stdio" : "Streamable HTTP"}；启用：${server.enabled}\n启动超时：${server.startup_timeout_sec} 秒；调用超时：${server.tool_timeout_sec} 秒\n`);
    if (kind === "strata") output.write(`本机视频范围：任意本机绝对路径（STRATA_VIDEO_ROOT=${server.env.STRATA_VIDEO_ROOT}；任何可使用此 MCP 的会话都能指定本机视频路径）\n渠道附件目录（确认后创建并设置私有权限）：${server.env.STRATA_VIDEO_CHANNEL_ROOT}\n视频传输：${server.env.STRATA_VIDEO_TRANSPORT}\n思考默认 medium；可选 none、low、medium、xhigh；预算由 Strata 管理。\n`);
    if (kind === "anysearch") output.write("服务地址：https://api.anysearch.com/mcp\n");
    output.write("参数、环境变量与 Header 值不回显；直接输入的密钥值将保存在用户配置中。\n");
    if (server.bearer_token_env_var || server.env_vars?.length || Object.keys(server.env_http_headers ?? {}).length) {
      output.write("引用的环境变量须由实际启动 Codex 的宿主提供。\n");
    }
    if (kind === "strata") output.write("启动命令：strata-video-mcp；标准 stdio MCP，官方 CLI 或其他客户端的 PATH 必须能找到随本项目安装的独立命令和 Node，不经过 codexc，也不保存版本目录。\n文件引用模式需要 Strata 启用 video_files；其他传输方式可通过自定义 stdio 或原生配置设置。\n");
    output.write("未读取插件清单；请使用独立名称，用户配置中的同名 MCP 会优先于插件服务器。\n");
    if (await ask("confirm", { message: "确认新增并保存上述 MCP？", initialValue: false }) !== true) return { action: "back" };
    if (kind === "strata") {
      if (strataChannelRoot({ environment, dataDir, configPath }) !== server.env.STRATA_VIDEO_CHANNEL_ROOT) {
        throw new Error("Gateway 渠道附件目录已变化，未写入 MCP；请重新进入菜单核对目录");
      }
      prepareStrataChannelRoot(server.env.STRATA_VIDEO_CHANNEL_ROOT);
      await videoConfiguration(server.env);
    }
    await saveMcpEdits(client, snapshot, [{ path: ["mcp_servers", name], value: server }], output);
    return { action: "added", name };
  }
  try {
    if (!["add", "edit", "delete"].includes(operation)) throw new Error("不支持的 MCP 管理操作");
    const kind = operation === "add" ? await ask("select", { message: "新增 MCP 类型", options: [
      ...mcpTypes,
      { value: "back", label: "返回" },
    ] }) : undefined;
    if (kind === "back") return { action: "back" };
    const type = mcpTypes.find(item => item.value === kind);
    if (operation === "add" && !type) throw new Error("不支持的 MCP 类型");
    return await withCodexUserConfigClient(environment, createClient, undefined,
      client => configure(client, kind, type), { preserveOperationResult: true });
  } catch (error) {
    if (error === cancelled) return { action: "back" };
    throw error;
  }
}
