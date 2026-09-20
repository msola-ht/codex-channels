const access = ["allow", "deny"];
const approvals = ["auto", "prompt", "writes", "approve"];
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
    add([...prefix, "default_tools_approval_mode"], `${label}：工具审批`, "choice", approvals);
    add([...prefix, "enabled_tools"], `${label}：允许的工具`, "list");
    add([...prefix, "disabled_tools"], `${label}：禁用的工具`, "list");
    if (!plugin) {
      add([...prefix, "startup_timeout_sec"], `${label}：启动超时（秒）`, "number");
      add([...prefix, "tool_timeout_sec"], `${label}：调用超时（秒）`, "number");
    }
    for (const tool of keys(config, merged, [...prefix, "tools"])) {
      add([...prefix, "tools", tool, "approval_mode"], `${label} / ${tool}：审批`, "choice", approvals);
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

export function toolSettingEdits(input, config, merged, invalid) {
  const field = projectToolSettings(config, merged).fields.find(
    (candidate) => JSON.stringify(candidate.path) === JSON.stringify(input.path),
  );
  if (field === undefined) {
    throw invalid("path", "unsupported-tool-setting", "请选择已有应用、站点或 MCP 的受支持设置");
  }
  const value = input.value;
  const error = toolSettingValueError(field, value);
  if (error !== undefined) throw invalid("value", "invalid-tool-setting", error);
  // The official key-path parser supports quoted segments and punctuation escapes.
  const keyPath = field.path.map((part) => `"${part.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(".");
  return { edits: [{ keyPath, value }], value: { path: field.path, value } };
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
