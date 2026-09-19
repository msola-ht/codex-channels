import { existsSync } from "node:fs";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { timezonePattern, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { loadGatewaySettings, updateGatewaySetting } from "./config-management.mjs";

const zoneinfoRoot = "/usr/share/zoneinfo";

export const timezoneCommandUsage = `用法：codexc timezone [<IANA 时区>|--system] [--json]

设置 App Server 与 WebUI 服务进程时区，决定模型请求 environment context 里的时区与当前日期，
WebUI 页面时间也随之呈现。缺省不写入配置，两个进程都沿用运行环境的系统时区。

  codexc timezone                    交互设置（预填当前值，留空即恢复系统时区）
  codexc timezone Asia/Shanghai      直接写入 [codex].timezone
  codexc timezone --system           删除该配置，恢复系统时区
  codexc timezone --json             只读输出当前配置；
                                     与时区名称或 --system 一起使用时输出写入结果

该值只写入 App Server 子进程与 WebUI 服务进程环境，不修改系统时区；
重启 App Server 与 WebUI 后生效。`;

/**
 * 解析 `codexc timezone` 参数：只接受一个 IANA 时区名称或 `--system`，两者互斥。
 * 时区名称在边界校验一次，格式与系统时区库同时检查，避免写入后由系统静默回退到 UTC。
 */
export function parseTimezoneCommandArgs(
  args,
  { exists = existsSync, root = zoneinfoRoot } = {},
) {
  let timezone = null;
  let useSystemTimezone = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--system") {
      if (useSystemTimezone) throw usageError("--system 只能出现一次");
      useSystemTimezone = true;
      continue;
    }
    if (arg === "--json") {
      if (json) throw usageError("--json 只能出现一次");
      json = true;
      continue;
    }
    if (arg.startsWith("-")) throw usageError(`未知参数：${arg}`);
    if (timezone !== null) throw usageError("只接受一个时区名称");
    timezone = arg;
  }
  if (timezone !== null && useSystemTimezone) {
    throw usageError("--system 不能与时区名称同时使用");
  }
  if (timezone !== null && !timezonePattern.test(timezone)) {
    throw usageError(
      `时区名称无效：${timezone}；需要 IANA 名称（如 Asia/Shanghai、America/Los_Angeles）`,
    );
  }
  if (timezone !== null && !isKnownTimezone(timezone, { exists, root })) {
    throw usageError(`系统时区库中没有 ${timezone}`);
  }
  if (timezone !== null) return { action: "set", timezone, json };
  if (useSystemTimezone) return { action: "clear", json };
  return { action: json ? "status" : "prompt", json };
}

/** 系统时区库缺失时不做存在性判断，交给运行 App Server 的平台解析。 */
export function isKnownTimezone(
  timezone,
  { exists = existsSync, root = zoneinfoRoot } = {},
) {
  if (!exists(join(root, "UTC"))) return true;
  return exists(join(root, timezone));
}

export function normalizeTimezoneInput(value, { exists = existsSync, root = zoneinfoRoot } = {}) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") return null;
  if (!timezonePattern.test(trimmed)) {
    return `时区名称无效：${trimmed}；需要 IANA 名称（如 Asia/Shanghai）`;
  }
  if (!isKnownTimezone(trimmed, { exists, root })) {
    return `系统时区库中没有 ${trimmed}`;
  }
  return undefined;
}

export async function runTimezoneCommand(args = [], {
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  writeConfig = writeGatewayConfig,
  normalize = normalizeTimezoneInput,
} = {}) {
  const parsed = parseTimezoneCommandArgs(args);
  const settings = loadGatewaySettings(environment);
  const current = settings.system.appServerTimezone;
  if (parsed.action === "status") {
    output.write(`${JSON.stringify({
      timezone: current,
      configPath: settings.configPath,
    })}\n`);
    return { action: "status", timezone: current, configPath: settings.configPath };
  }
  if (parsed.action === "prompt" && (!output.isTTY || !prompts)) {
    writeCurrentTimezone({ environment, output, current, configPath: settings.configPath });
    return { action: "status", timezone: current, configPath: settings.configPath };
  }
  let next = parsed.action === "clear" ? null : parsed.timezone;
  if (parsed.action === "prompt") {
    const value = await prompts.text({
      message: "模型可见时区（IANA 名称，如 America/Los_Angeles）；留空恢复系统时区",
      initialValue: current ?? "",
      validate: normalize,
    });
    if (prompts.isCancel(value)) {
      output.write("已取消时区设置\n");
      return { action: "cancelled" };
    }
    const normalized = value.trim();
    next = normalized === "" ? null : normalized;
  }
  const result = updateGatewaySetting({
    kind: "system.app-server-timezone",
    value: next,
  }, {
    environment,
    expectedRevision: settings.revision,
    writeConfig,
  });
  if (parsed.json) {
    output.write(`${JSON.stringify({
      timezone: result.value,
      configPath: result.configPath,
    })}\n`);
    return { action: "saved", timezone: result.value, configPath: result.configPath };
  }
  writeCliMessage("success", result.value === null
    ? `已恢复系统时区，App Server 与 WebUI 下次启动后使用运行环境的时区：${result.configPath}`
    : `模型可见时区已设为 ${result.value}（App Server 与 WebUI）：${result.configPath}`, {
    stdout: output,
    environment,
  });
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return {
    action: "saved",
    timezone: result.value,
    configPath: result.configPath,
    activation: result.activation,
    activationResult: result.activationResult,
  };
}

function writeCurrentTimezone({ environment, output, current, configPath }) {
  writeCliMessage("note", current === null
    ? `当前未设置模型可见时区，App Server 与 WebUI 沿用系统时区：${configPath}`
    : `当前模型可见时区：${current}（App Server 与 WebUI，${configPath}）`, {
    stdout: output,
    environment,
  });
}

function usageError(message) {
  return new Error(`${message}\n\n${timezoneCommandUsage}`);
}
