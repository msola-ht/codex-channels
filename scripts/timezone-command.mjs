import { existsSync } from "node:fs";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { timezonePattern, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { loadGatewaySettings, updateGatewaySetting } from "./config-management.mjs";

const zoneinfoRoot = "/usr/share/zoneinfo";
/** 交互选择里“恢复系统时区”的哨兵值：不是合法 IANA 名称，不会与列表项冲突。 */
export const systemTimezoneValue = "__system__";
/** 交互选择里“手动输入”的哨兵值。 */
export const customTimezoneValue = "__custom__";
/** 交互入口只列常见时区，其余名称走「其他」手动输入，避免几百条列表。 */
export const commonTimezones = [
  { value: "Asia/Shanghai", hint: "中国标准时间 UTC+8，无夏令时" },
  { value: "Asia/Tokyo", hint: "日本标准时间 UTC+9" },
  { value: "Europe/London", hint: "英国时间 UTC+0 / 夏令时 UTC+1" },
  { value: "America/New_York", hint: "美国东部 UTC-5 / 夏令时 UTC-4" },
  { value: "America/Los_Angeles", hint: "美国西部 UTC-8 / 夏令时 UTC-7" },
  { value: "UTC", hint: "协调世界时" },
];

export const timezoneCommandUsage = `用法：codexc timezone [<IANA 时区>|--system] [--json]

设置 App Server 与 WebUI 服务进程时区，决定模型请求 environment context 里的时区与当前日期，
WebUI 页面时间也随之呈现。缺省不写入配置，两个进程都沿用运行环境的系统时区。

  codexc timezone                    交互选择常见时区，或选“其他”手动输入 IANA 名称；
                                     选中“恢复系统时区”即删除该配置
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

/** 交互选择的可选项：恢复系统时区、常见时区、当前值（不在常见列表时）与手动输入。 */
export function timezoneChoices(current) {
  const common = commonTimezones.map(({ value, hint }) => ({ value, label: value, hint }));
  const configured = current !== null && !commonTimezones.some(({ value }) => value === current)
    ? [{ value: current, label: current, hint: "当前配置" }]
    : [];
  return [
    { value: systemTimezoneValue, label: "恢复系统时区", hint: "删除 codex.timezone，沿用系统时区" },
    ...configured,
    ...common,
    { value: customTimezoneValue, label: "其他（手动输入 IANA 名称）", hint: "如 Etc/GMT+8、Asia/Kolkata" },
  ];
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
    const choices = timezoneChoices(current);
    const value = await prompts.select({
      message: "模型可见时区",
      showInstructions: false,
      initialValue: current !== null && choices.some((choice) => choice.value === current)
        ? current
        : systemTimezoneValue,
      options: choices,
    });
    if (prompts.isCancel(value)) {
      output.write("已取消时区设置\n");
      return { action: "cancelled" };
    }
    if (value === customTimezoneValue) {
      const typed = await prompts.text({
        message: "IANA 时区名称（如 Asia/Kolkata、Etc/GMT+8）；留空恢复系统时区",
        initialValue: "",
        validate: normalize,
      });
      if (prompts.isCancel(typed)) {
        output.write("已取消时区设置\n");
        return { action: "cancelled" };
      }
      next = typed.trim() === "" ? null : typed.trim();
    } else {
      next = value === systemTimezoneValue ? null : value;
    }
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
