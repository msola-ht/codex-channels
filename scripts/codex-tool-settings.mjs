import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { packageDir } from "./package-path.mjs";
import { videoConfiguration } from "./video-analysis-client.mjs";

const access = ["allow", "deny"];
export const mcpToolApprovalModes = ["auto", "prompt", "writes", "approve"];
const originFields = ["access", "downloads", "uploads", "full_cdp_access"];

/** Project only editable policy fields, never MCP transport or credentials. */
export function projectToolSettings(config, merged) {
  const fields = [];
  const add = (path, label, type, options = null) => fields.push({
    path, label, type, options,
    userValue: at(config, path) ?? null,
    mergedValue: merged === undefined ? null : at(merged, path) ?? null,
  });
  add(["computer_use", "default_app_access"], "电脑：默认应用访问", "choice", access);
  add(["browser_use", "allow_history_access"], "浏览器：读取历史记录", "boolean");
  for (const name of originFields) {
    add(["browser_use", "default_origin_policy", name], `浏览器默认：${name}`, "choice", access);
  }
  for (const [platform, key] of [["macos", "bundle_ids"], ["windows", "aumids"]]) {
    const prefix = ["computer_use", platform, key];
    for (const id of keys(config, merged, prefix)) {
      add([...prefix, id], `${platform} 应用：${id}`, "choice", access);
    }
  }
  for (const origin of keys(config, merged, ["browser_use", "origins"])) {
    for (const name of originFields) {
      add(["browser_use", "origins", origin, name], `${origin}：${name}`, "choice", access);
    }
  }
  const addServer = (prefix, label, plugin) => {
    add([...prefix, "enabled"], `${label}：启用`, "boolean");
    add([...prefix, "default_tools_approval_mode"], `${label}：工具审批`, "choice", mcpToolApprovalModes);
    add([...prefix, "enabled_tools"], `${label}：允许的工具`, "list");
    add([...prefix, "disabled_tools"], `${label}：禁用的工具`, "list");
    if (!plugin) {
      add([...prefix, "startup_timeout_sec"], `${label}：启动超时（秒）`, "number");
      add([...prefix, "tool_timeout_sec"], `${label}：调用超时（秒）`, "number");
    }
    for (const tool of keys(config, merged, [...prefix, "tools"])) {
      add([...prefix, "tools", tool, "approval_mode"], `${label} / ${tool}：审批`, "choice", mcpToolApprovalModes);
      add([...prefix, "tools", tool, "output_token_limit"], `${label} / ${tool}：输出 token 上限`, "integer");
    }
  };
  for (const server of keys(config, merged, ["mcp_servers"])) {
    addServer(["mcp_servers", server], `MCP ${server}`, false);
  }
  for (const plugin of keys(config, merged, ["plugins"])) {
    for (const server of keys(config, merged, ["plugins", plugin, "mcp_servers"])) {
      addServer(["plugins", plugin, "mcp_servers", server], `插件 ${plugin} / ${server}`, true);
    }
  }
  return { mergedAvailable: merged !== undefined, fields };
}

export async function toolSettingEdits(input, config, merged, invalid) {
  const field = projectToolSettings(config, merged).fields.find(
    (candidate) => JSON.stringify(candidate.path) === JSON.stringify(input.path),
  );
  if (field === undefined) {
    throw invalid("path", "unsupported-tool-setting", "请选择已有应用、站点或 MCP 的受支持设置");
  }
  const value = input.value;
  const error = toolSettingValueError(field, value);
  if (error !== undefined) throw invalid("value", "invalid-tool-setting", error);
  if (field.path[0] === "mcp_servers" && field.path[2] === "tool_timeout_sec") {
    try {
      await validateStrataMcpEdit(config, merged, field.path[1], "tool_timeout_sec", value);
    } catch (error) {
      throw invalid("value", "invalid-tool-setting", error.message);
    }
  }
  // The official key-path parser supports quoted segments and punctuation escapes.
  const keyPath = field.path.map((part) => `"${part.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(".");
  return { edits: [{ keyPath, value }], value: { path: field.path, value } };
}

export function isStrataServer(server) {
  return typeof server?.command === "string" && !server.url
    && Array.isArray(server.args)
    && ((server.command === "codexc" && server.args[0] === "video-mcp")
      || server.args[0] === join(packageDir, "scripts", "video-analysis-mcp.mjs"));
}

/** Validate the actual merged target, without guessing values hidden below user overrides. */
export async function validateStrataMcpEdit(config, merged, name, field, value) {
  if (!["env", "env_vars", "tool_timeout_sec", "args", "command", "url"].includes(field)) return;
  const own = at(config, ["mcp_servers", name]) ?? {};
  const effective = at(merged, ["mcp_servers", name]);
  if (merged === undefined || effective === undefined) {
    throw new Error("无法读取 MCP 合并配置，不能确认实际目标及 Strata 分析时限；请重新读取或通过原生配置编辑，未保存");
  }
  const candidate = { ...effective };
  if (value !== null) candidate[field] = value;
  if (!isStrataServer(effective) && !isStrataServer(candidate)) return;
  if (value === null && own[field] !== undefined) {
    throw new Error("移除 Strata 用户覆盖后无法确认继承配置的有效值；请通过原生配置核对分析时限与 MCP 调用超时，未保存");
  }
  if (value !== null && own[field] !== undefined && !isDeepStrictEqual(own[field], effective[field])) {
    throw new Error("Strata 字段受其他配置来源影响，无法确认修改后的有效值；请通过原生配置编辑，未保存");
  }
  if (!isStrataServer(candidate)) return;
  // A complete env replacement can reveal lower-layer values for omitted user keys.
  if (field === "env" && value !== null) {
    if (Object.keys(own.env ?? {}).some(key => !Object.hasOwn(value, key))) {
      throw new Error("Strata 环境变量整组替换会恢复无法确认的继承值；请保留原字段或通过原生配置编辑，未保存");
    }
    candidate.env = { ...effective.env, ...value };
  }
  const env = { ...candidate.env };
  const inherited = new Set((candidate.env_vars ?? []).map(item => typeof item === "string" ? item : item.name));
  if (["STRATA_VIDEO_BASE_URL", "STRATA_VIDEO_MODEL", "STRATA_VIDEO_ROOT", "STRATA_VIDEO_CHANNEL_ROOT", "STRATA_VIDEO_TRANSPORT", "STRATA_VIDEO_TIMEOUT_SECONDS"]
    .some(key => env[key] === undefined && inherited.has(key))) {
    throw new Error("Strata 参数依赖实际 MCP 宿主环境，无法确认分析时限或目录范围；请通过原生配置编辑，未保存");
  }
  if (env.STRATA_VIDEO_API_KEY === undefined && inherited.has("STRATA_VIDEO_API_KEY")) env.STRATA_VIDEO_API_KEY = "host-provided-key";
  const video = await videoConfiguration(env);
  if (field === "tool_timeout_sec" && value !== null
    && !(effective.tool_timeout_sec > video.timeoutMs / 1000)) {
    throw new Error("现有 Strata 合并调用超时不足，无法排除其他来源继续覆盖本次修改；请通过原生配置修复并重新读取，未保存");
  }
  if (!(candidate.tool_timeout_sec > video.timeoutMs / 1000)) {
    throw new Error("Strata MCP 调用超时必须大于视频分析总时限；不能缩短到分析时限以内，未保存");
  }
  return { timeoutSeconds: video.timeoutMs / 1000, toolTimeoutSeconds: candidate.tool_timeout_sec,
    root: env.STRATA_VIDEO_ROOT, channelRoot: env.STRATA_VIDEO_CHANNEL_ROOT };
}

export function toolSettingValueError(field, value) {
  const valid = value === null
    || (field.type === "boolean" && typeof value === "boolean")
    || (field.type === "choice" && field.options.includes(value))
    || (field.type === "number" && typeof value === "number" && Number.isFinite(value) && value > 0)
    || (field.type === "integer" && Number.isSafeInteger(value) && value > 0)
    || (field.type === "list" && Array.isArray(value)
      && value.every((name) => typeof name === "string" && name.trim() !== "")
      && new Set(value).size === value.length);
  if (valid) return undefined;
  if (field.type === "list") return "请输入不重复的非空工具名 JSON 数组，例如 [\"read\"]；留空移除用户设置";
  if (field.type === "integer") return "请输入正整数；留空移除用户设置";
  if (field.type === "number") return "请输入大于 0 的有限数字；留空移除用户设置";
  return "工具设置值无效";
}

function at(config, path) {
  let value = config;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function keys(config, merged, path) {
  const ownKeys = (value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value) : [];
  return [...new Set([...ownKeys(at(config, path)), ...ownKeys(at(merged, path))])].sort();
}
