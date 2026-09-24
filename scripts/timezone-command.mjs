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
      codexc timezone --gateway [<IANA 时区>|--follow-app-server|--system] [--json]

设置 App Server 与 WebUI 服务进程时区，决定模型请求 environment context 里的时区与当前日期，
WebUI 页面时间也随之呈现。缺省不写入配置，两个进程都沿用运行环境的系统时区。

  codexc timezone                    交互选择常见时区，或选“其他”手动输入 IANA 名称；
                                     选中“恢复系统时区”即删除该配置
  codexc timezone Asia/Shanghai      直接写入 [codex].timezone
  codexc timezone --system           删除该配置，恢复系统时区
  codexc timezone --json             只读输出当前配置；
                                     与时区名称或 --system 一起使用时输出写入结果
  codexc timezone --gateway          交互设置网关时区
  codexc timezone --gateway --follow-app-server
                                     网关启动时跟随 codex.timezone，未配置则沿用系统时区
  codexc timezone --gateway Asia/Shanghai
                                     为网关设置独立 IANA 时区
  codexc timezone --gateway --system 写入 gateway.timezone = "system"，使用系统时区

默认入口写入 App Server 与 WebUI 时区配置，未设置独立时区的网关也跟随；不修改系统时区。
修改 App Server 时区后，App Server、Gateway 与 WebUI 均需重启；托管网关自动重启，
直接运行的网关需重新执行原启动命令。--gateway 只设置网关，重启网关后生效；
网关未设置时默认跟随 codex.timezone，--follow-app-server 删除网关独立设置。`;

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
  let gateway = false;
  let followAppServer = false;
  for (const arg of args) {
    if (arg === "--gateway") {
      if (gateway) throw usageError("--gateway 只能出现一次");
      gateway = true;
      continue;
    }
    if (arg === "--follow-app-server") {
      if (followAppServer) throw usageError("--follow-app-server 只能出现一次");
      followAppServer = true;
      continue;
    }
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
  if (followAppServer && (!gateway || useSystemTimezone || timezone !== null)) {
    throw usageError("--follow-app-server 必须与 --gateway 一起使用，且不能与 --system 或时区名称同时使用");
  }
  const target = gateway ? { gateway: true } : {};
  if (followAppServer) return { action: "set", timezone: "app-server", json, ...target };
  if (gateway && timezone === "system") throw usageError("系统时区请使用 --system");
  if (timezone !== null && !timezonePattern.test(timezone)) {
    throw usageError(
      `时区名称无效：${timezone}；需要 IANA 名称（如 Asia/Shanghai、America/Los_Angeles）`,
    );
  }
  if (timezone !== null && !isKnownTimezone(timezone, { exists, root })) {
    throw usageError(`系统时区库中没有 ${timezone}`);
  }
  if (timezone !== null) return { action: "set", timezone, json, ...target };
  if (useSystemTimezone) return { action: "clear", json, ...target };
  return { action: json ? "status" : "prompt", json, ...target };
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
export function timezoneChoices(current, gateway = false) {
  const common = commonTimezones.map(({ value, hint }) => ({ value, label: value, hint }));
  const configured = current !== null && !(gateway && (current === "app-server" || current === "system"))
    && !commonTimezones.some(({ value }) => value === current)
    ? [{ value: current, label: current, hint: "当前配置" }]
    : [];
  return [
    ...(gateway ? [{ value: "app-server", label: "跟随 App Server（默认）", hint: "删除 gateway.timezone；App Server 未配置则沿用系统时区" }] : []),
    { value: systemTimezoneValue, label: gateway ? "系统时区" : "恢复系统时区", hint: gateway
      ? "独立使用系统时区，不跟随 App Server" : "删除 codex.timezone，沿用系统时区" },
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
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  writeConfig = writeGatewayConfig,
  normalize = normalizeTimezoneInput,
} = {}) {
  const parsed = parseTimezoneCommandArgs(args);
  const settings = loadGatewaySettings(environment);
  const gateway = parsed.gateway === true;
  const current = gateway ? settings.system.gatewayTimezone : settings.system.appServerTimezone;
  if (parsed.action === "status") {
    output.write(`${JSON.stringify({
      timezone: current,
      configPath: settings.configPath,
    })}\n`);
    return { action: "status", timezone: current, configPath: settings.configPath };
  }
  if (parsed.action === "prompt" && (!input.isTTY || !output.isTTY || !prompts)) {
    writeCurrentTimezone({ environment, output, current, configPath: settings.configPath, gateway });
    return { action: "status", timezone: current, configPath: settings.configPath };
  }
  let next = parsed.action === "clear" ? (gateway ? "system" : null) : parsed.timezone;
  if (parsed.action === "prompt") {
    const choices = timezoneChoices(current, gateway);
    const value = await prompts.select({
      message: gateway ? "网关时区" : "模型可见时区",
      showInstructions: false,
      initialValue: gateway && current === null ? "app-server"
        : current !== null && choices.some((choice) => choice.value === current)
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
        message: gateway
          ? "IANA 时区名称（如 Asia/Kolkata、Etc/GMT+8）；留空跟随 App Server"
          : "IANA 时区名称（如 Asia/Kolkata、Etc/GMT+8）；留空恢复系统时区",
        initialValue: "",
        validate: normalize,
      });
      if (prompts.isCancel(typed)) {
        output.write("已取消时区设置\n");
        return { action: "cancelled" };
      }
      next = typed.trim() === "" ? null : typed.trim();
    } else {
      next = value === systemTimezoneValue ? (gateway ? "system" : null) : value;
    }
  }
  const result = updateGatewaySetting({
    kind: gateway ? "system.gateway-timezone" : "system.app-server-timezone",
    value: gateway && next === "app-server" ? null : next,
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
  writeCliMessage("success", gateway
    ? `网关时区已设为${gatewayTimezoneLabel(result.value)}：${result.configPath}`
    : result.value === null
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

function writeCurrentTimezone({ environment, output, current, configPath, gateway }) {
  writeCliMessage("note", gateway
    ? `当前网关时区：${gatewayTimezoneLabel(current)}（${configPath}）`
    : current === null
    ? `当前未设置模型可见时区，App Server 与 WebUI 沿用系统时区：${configPath}`
    : `当前模型可见时区：${current}（App Server 与 WebUI，${configPath}）`, {
    stdout: output,
    environment,
  });
}

function gatewayTimezoneLabel(value) {
  if (value === null || value === "app-server") return "跟随 App Server";
  return value === "system" ? "系统时区" : value;
}

function usageError(message) {
  return new Error(`${message}\n\n${timezoneCommandUsage}`);
}
