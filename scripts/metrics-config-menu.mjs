import { isPrivateHttpEndpoint } from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";

const deviceIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export async function runMetricsSettings({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  while (true) {
    const section = await prompts.select({
      message: "选择指标设置",
      showInstructions: false,
      options: [
        {
          value: "connect",
          label: "本机接入中心",
          hint: "配置指标上报与 WebUI 全局视图",
        },
        {
          value: "status",
          label: "查看接入状态",
          hint: "显示上报与全局视图的当前配置",
        },
        {
          value: "sync_params",
          label: "上报参数",
          hint: "上报间隔与单批条数上限",
        },
        {
          value: "storage",
          label: "本地保留策略",
          hint: "保留天数与最大记录数",
        },
        {
          value: "disable",
          label: "停用接入",
          hint: "停用上报与全局视图（配置保留）",
        },
        { value: "back", label: "返回", hint: "返回配置菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") {
      return { action: "back" };
    }
    if (section === "connect") {
      const result = await runConnectToCenter({
        environment,
        output,
        prompts,
        writeConfig,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    if (section === "status") {
      await runMetricsStatus({ environment, output });
      continue;
    }
    if (section === "sync_params") {
      const result = await runSyncParams({
        environment,
        output,
        prompts,
        writeConfig,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    if (section === "storage") {
      const result = await runMetricsStorage({
        environment,
        output,
        prompts,
        writeConfig,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    if (section === "disable") {
      const result = await runDisableConnection({
        environment,
        output,
        writeConfig,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    throw new Error(`未知多设备指标设置：${String(section)}`);
  }
}

async function runMetricsStorage({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const storage = settings.metrics.storage;
  const retentionDays = await prompts.text({
    message: "本地指标保留天数（1–3650）",
    initialValue: String(storage.retentionDays),
    validate: (value) => boundedIntegerMessage(value, 1, 3650),
  });
  if (prompts.isCancel(retentionDays)) return { action: "back" };
  const maxRows = await prompts.text({
    message: "本地指标最大行数（1000–10000000）",
    initialValue: String(storage.maxRows),
    validate: (value) => boundedIntegerMessage(value, 1_000, 10_000_000),
  });
  if (prompts.isCancel(maxRows)) return { action: "back" };
  const next = { retentionDays: Number(retentionDays), maxRows: Number(maxRows) };
  if (
    boundedIntegerMessage(next.retentionDays, 1, 3650) !== undefined
    || boundedIntegerMessage(next.maxRows, 1_000, 10_000_000) !== undefined
  ) {
    throw new Error("本地指标保留策略无效");
  }
  const result = updateGatewaySetting({ kind: "metrics.storage", ...next }, {
    environment,
    expectedRevision: settings.revision,
    writeConfig,
  });
  output.write(`本地指标保留策略已更新：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, "restart");
  output.write("需要立即清理时运行 codexc metrics cleanup。\n");
  return {
    storage: { retention_days: next.retentionDays, max_rows: next.maxRows },
    configPath: result.configPath,
  };
}

function boundedIntegerMessage(value, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? undefined
    : `请输入 ${minimum}–${maximum} 之间的整数`;
}

async function runConnectToCenter({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const endpoint = await prompts.text({
    message: "中心地址（例如 https://center.example.com 或 http://127.0.0.1:8790）",
    validate: (input) => {
      try {
        normalizeEndpoint(String(input).trim());
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (prompts.isCancel(endpoint)) return { action: "back" };
  const base = normalizeEndpoint(String(endpoint).trim());
  const deviceToken = await prompts.password({
    message: "设备上报令牌",
  });
  if (prompts.isCancel(deviceToken)) return { action: "back" };
  const normalizedDeviceToken = String(deviceToken).trim();
  if (normalizedDeviceToken.length === 0) {
    output.write("设备上报令牌不能为空。\n");
    return { action: "back" };
  }
  const viewToken = await prompts.password({
    message: "全局查看令牌（必须与设备上报令牌不同）",
  });
  if (prompts.isCancel(viewToken)) return { action: "back" };
  const normalizedViewToken = String(viewToken).trim();
  if (normalizedViewToken.length === 0) {
    output.write("全局查看令牌不能为空。\n");
    return { action: "back" };
  }
  if (normalizedViewToken === normalizedDeviceToken) {
    output.write("设备上报令牌与全局查看令牌必须不同。\n");
    return { action: "back" };
  }
  const deviceId = await prompts.text({
    message: "设备 ID（可留空自动生成）",
    initialValue: "",
  });
  if (prompts.isCancel(deviceId)) return { action: "back" };
  const normalizedDeviceId = String(deviceId).trim();
  if (normalizedDeviceId.length > 0 && !deviceIdPattern.test(normalizedDeviceId)) {
    output.write(
      "设备 ID 必须以小写字母或数字开头，只能包含小写字母、数字、- 和 _，最长 64 位。\n",
    );
    return { action: "back" };
  }

  const settings = loadGatewaySettings(environment);
  const result = updateGatewaySetting({
    kind: "metrics.connect",
    endpoint: base,
    deviceToken: normalizedDeviceToken,
    viewToken: normalizedViewToken,
    deviceId: normalizedDeviceId || null,
  }, {
    environment,
    expectedRevision: settings.revision,
    writeConfig,
  });
  output.write(`已接入中心：${base}\n`);
  output.write(`设备 ID：${normalizedDeviceId || settings.metrics.sync.deviceId || "自动生成"}\n`);
  output.write("配置已写入并备份。\n");
  writeGatewayConfigActivationNotice(output, environment, "restart");
  output.write("WebUI 全局页将在重启 WebUI 后生效。\n");
  return { endpoint: base, deviceId: normalizedDeviceId || null, configPath: result.configPath };
}

async function runMetricsStatus({ environment, output }) {
  const metrics = loadGatewaySettings(environment).metrics;
  output.write(`上报：${metrics.sync.enabled ? "已启用" : "已停用"}\n`);
  output.write(`上报端点：${metrics.sync.endpoint ?? "未配置"}\n`);
  output.write(`设备 ID：${metrics.sync.deviceId ?? "自动生成"}\n`);
  output.write(`上报间隔：${metrics.sync.intervalSeconds} 秒\n`);
  output.write(`单批上限：${metrics.sync.batchSize} 条\n`);
  output.write(`WebUI 全局视图：${metrics.view.enabled ? "已启用" : "已停用"}\n`);
  output.write(`查看端点：${metrics.view.endpoint ?? "未配置"}\n`);
  output.write(`设备上报令牌：${metrics.sync.deviceTokenConfigured ? "已配置" : "未配置"}\n`);
  output.write(`全局查看令牌：${metrics.view.tokenConfigured ? "已配置" : "未配置"}\n`);
  return { action: "back" };
}

async function runSyncParams({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  while (true) {
    const settings = loadGatewaySettings(environment);
    const sync = settings.metrics.sync;
    const section = await prompts.select({
      message: "选择上报参数",
      showInstructions: false,
      options: [
        {
          value: "interval_seconds",
          label: "上报间隔",
          hint: `当前：${sync.intervalSeconds} 秒（10–86400）`,
        },
        {
          value: "batch_size",
          label: "单批上限",
          hint: `当前：${sync.batchSize} 条（1–500）`,
        },
        { value: "back", label: "返回", hint: "返回多设备指标菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") {
      return { action: "back" };
    }
    if (section === "interval_seconds") {
      const value = await prompts.text({
        message: "上报间隔（秒，10–86400，默认 60）",
        initialValue: String(sync.intervalSeconds),
        validate: (input) => {
          const parsed = Number(input);
          return Number.isInteger(parsed) && parsed >= 10 && parsed <= 86400
            ? undefined
            : "请输入 10–86400 之间的整数";
        },
      });
      if (prompts.isCancel(value)) continue;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 10 || parsed > 86400) {
        output.write("上报间隔必须是 10–86400 之间的整数。\n");
        continue;
      }
      const result = updateGatewaySetting({ kind: "metrics.sync-params", intervalSeconds: parsed }, {
        environment,
        expectedRevision: settings.revision,
        writeConfig,
      });
      output.write(`上报参数已更新：${result.configPath}\n`);
      writeGatewayConfigActivationNotice(output, environment, "restart");
      return { sync: { interval_seconds: parsed }, configPath: result.configPath };
    } else if (section === "batch_size") {
      const value = await prompts.text({
        message: "单批条数上限（1–500，默认 200）",
        initialValue: String(sync.batchSize),
        validate: (input) => {
          const parsed = Number(input);
          return Number.isInteger(parsed) && parsed >= 1 && parsed <= 500
            ? undefined
            : "请输入 1–500 之间的整数";
        },
      });
      if (prompts.isCancel(value)) continue;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        output.write("单批条数上限必须是 1–500 之间的整数。\n");
        continue;
      }
      const result = updateGatewaySetting({ kind: "metrics.sync-params", batchSize: parsed }, {
        environment,
        expectedRevision: settings.revision,
        writeConfig,
      });
      output.write(`上报参数已更新：${result.configPath}\n`);
      writeGatewayConfigActivationNotice(output, environment, "restart");
      return { sync: { batch_size: parsed }, configPath: result.configPath };
    } else {
      throw new Error(`未知上报参数：${String(section)}`);
    }
  }
}

async function runDisableConnection({ environment, output, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const result = updateGatewaySetting({ kind: "metrics.disconnect" }, {
    environment,
    expectedRevision: settings.revision,
    writeConfig,
  });
  output.write("已停用中心接入（配置保留，可在「多设备指标」中重新配置）。\n");
  writeGatewayConfigActivationNotice(output, environment, "restart");
  output.write("WebUI 全局页将在重启 WebUI 后生效。\n");
  return { disabled: true, configPath: result.configPath };
}

export async function runCenterSettings({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  while (true) {
    const settings = loadGatewaySettings(environment);
    const center = settings.metrics.center;
    const section = await prompts.select({
      message: "选择中心服务设置",
      showInstructions: false,
      options: [
        {
          value: "enabled",
          label: "启用状态",
          hint: `当前：${center.enabled ? "已启用" : "已停用"}`,
        },
        {
          value: "host",
          label: "监听地址",
          hint: `当前：${center.host}`,
        },
        {
          value: "port",
          label: "监听端口",
          hint: `当前：${center.port}`,
        },
        {
          value: "token",
          label: "查看令牌",
          hint: center.tokenConfigured ? "已设置（内容不显示）" : "未设置；绑定 0.0.0.0 时必须设置",
        },
        {
          value: "device_token",
          label: "设备上报令牌",
          hint: center.deviceTokenConfigured ? "已设置（内容不显示）" : "未设置；绑定 0.0.0.0 时必须设置",
        },
        {
          value: "database_path",
          label: "数据库路径",
          hint: `当前：${center.databasePath}`,
        },
        { value: "back", label: "返回", hint: "返回多设备指标菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") {
      return { action: "back" };
    }
    let input;
    if (section === "enabled") {
      const selected = await prompts.select({
        message: "中心服务启用状态",
        showInstructions: false,
        initialValue: center.enabled ? "enabled" : "disabled",
        options: [
          { value: "enabled", label: "启用", hint: "启动 codexc center 后接收设备上报" },
          { value: "disabled", label: "停用", hint: "停止接收上报" },
          { value: "back", label: "返回上一级" },
        ],
      });
      if (prompts.isCancel(selected) || selected === "back") continue;
      if (selected !== "enabled" && selected !== "disabled") {
        throw new Error(`未知中心服务状态：${String(selected)}`);
      }
      input = { kind: "metrics.center.enabled", value: selected === "enabled" };
    } else if (section === "host") {
      const selected = await prompts.select({
        message: "监听地址",
        showInstructions: false,
        initialValue: center.host,
        options: [
          { value: "127.0.0.1", label: "仅本机", hint: "默认，仅本机 WebUI 可用" },
          { value: "::1", label: "仅本机（IPv6 回环）", hint: "IPv6 环境使用" },
          { value: "0.0.0.0", label: "所有网卡", hint: "其他设备接入，必须设置令牌" },
          { value: "clear", label: "恢复默认", hint: "回到仅本机" },
        ],
      });
      if (prompts.isCancel(selected)) continue;
      let token;
      let deviceToken;
      if (selected === "0.0.0.0" && !center.tokenConfigured) {
        token = await prompts.password({ message: "绑定 0.0.0.0 必须设置查看令牌（留空取消）" });
        if (prompts.isCancel(token) || String(token).trim() === "") continue;
      }
      if (selected === "0.0.0.0" && !center.deviceTokenConfigured) {
        deviceToken = await prompts.password({ message: "绑定 0.0.0.0 必须设置设备上报令牌（留空取消）" });
        if (prompts.isCancel(deviceToken) || String(deviceToken).trim() === "") continue;
      }
      input = {
        kind: "metrics.center.host",
        value: selected === "clear" ? null : selected,
        ...(token === undefined ? {} : { token: String(token).trim() }),
        ...(deviceToken === undefined ? {} : { deviceToken: String(deviceToken).trim() }),
      };
    } else if (section === "port") {
      const value = await prompts.text({
        message: "监听端口（1–65535，默认 8790）",
        initialValue: String(center.port),
      });
      if (prompts.isCancel(value)) continue;
      const port = Number(String(value).trim());
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        output.write("端口必须是 1 到 65535 的整数。\n");
        continue;
      }
      input = { kind: "metrics.center.port", value: port };
    } else if (section === "token" || section === "device_token") {
      const tokenField = section;
      const tokenLabel = tokenField === "token" ? "查看令牌" : "设备上报令牌";
      const configured = tokenField === "token" ? center.tokenConfigured : center.deviceTokenConfigured;
      const action = await prompts.select({
        message: tokenLabel,
        showInstructions: false,
        options: [
          {
            value: "set",
            label: configured ? "重新设置令牌" : "设置令牌",
            hint: configured
              ? "替换现有令牌"
              : "绑定 0.0.0.0 时必须设置",
          },
          ...(configured ? [{ value: "clear", label: "清除令牌", hint: "清除后不能再绑定 0.0.0.0" }] : []),
          { value: "back", label: "返回上一级" },
        ],
      });
      if (prompts.isCancel(action) || action === "back") continue;
      if (action === "clear") {
        if (center.host === "0.0.0.0") {
          output.write("绑定 0.0.0.0 时必须保留访问令牌，请先改回仅本机。\n");
          continue;
        }
        input = { kind: "metrics.center.token", field: tokenField, action: "clear" };
      } else if (action === "set") {
        const token = await prompts.password({
          message: `输入${tokenLabel}（留空取消）`,
        });
        if (prompts.isCancel(token) || String(token).trim() === "") continue;
        input = {
          kind: "metrics.center.token",
          field: tokenField,
          action: "set",
          value: String(token).trim(),
        };
      } else {
        throw new Error(`未知${tokenLabel}操作：${String(action)}`);
      }
    } else if (section === "database_path") {
      const value = await prompts.text({
        message: "中心 SQLite 路径（相对配置目录或绝对路径）",
        initialValue: center.databasePath,
      });
      if (prompts.isCancel(value)) continue;
      const path = String(value).trim();
      if (path.length === 0) {
        output.write("数据库路径不能为空。\n");
        continue;
      }
      input = { kind: "metrics.center.database-path", value: path };
    } else {
      throw new Error(`未知中心服务设置：${String(section)}`);
    }
    const result = updateGatewaySetting(input, {
      environment,
      expectedRevision: settings.revision,
      writeConfig,
    });
    output.write(`中心服务设置已更新：${result.configPath}\n`);
    output.write("配置在重启 codexc center 后生效。\n");
    return { center: result.value.center, configPath: result.configPath };
  }
}

function isBackResult(value) {
  return value !== null
    && typeof value === "object"
    && value.action === "back";
}

function normalizeEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`中心地址无效：${value}`);
  }
  if (url.protocol !== "https:" && !isPrivateHttpEndpoint(url)) {
    throw new Error("中心地址必须使用 HTTPS，或指向回环/私网地址的 HTTP");
  }
  return url.toString().replace(/\/+$/u, "");
}
