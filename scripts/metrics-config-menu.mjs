import { hostname } from "node:os";

import { isPrivateHttpEndpoint } from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";


export async function runMetricsSettings({
  environment,
  output,
  prompts,
  writeConfig,
  restartCenter,
  restartGateway,
  restartWebui,
}) {
  while (true) {
    const section = await prompts.select({
      message: "选择数据中心设置",
      showInstructions: false,
      options: [
        {
          value: "connect",
          label: "本机接入数据中心",
          hint: "配置本机上报与全局查询",
        },
        {
          value: "status",
          label: "查看数据中心状态",
          hint: "显示配置状态与中心健康状态",
        },
        {
          value: "sync_params",
          label: "本机上报参数",
          hint: "上报间隔与单批条数上限",
        },
        {
          value: "storage",
          label: "本机数据保留",
          hint: "保留天数与最大记录数",
        },
        {
          value: "center",
          label: "数据中心服务配置",
          hint: "监听地址、双令牌、数据库和令牌生成",
        },
        {
          value: "disable",
          label: "停用本机接入",
          hint: "停用本机上报与全局查询（保留配置）",
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
        restartGateway,
        restartWebui,
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
    if (section === "center") {
      const result = await runCenterSettings({
        environment,
        output,
        prompts,
        writeConfig,
        restartCenter,
        restartGateway,
        restartWebui,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    if (section === "disable") {
      const result = await runDisableConnection({
        environment,
        output,
        writeConfig,
        restartGateway,
        restartWebui,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    throw new Error(`未知数据中心设置：${String(section)}`);
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
  writeGatewayConfigActivationNotice(output, environment, result.activation === "none" ? "none" : "restart");
  output.write("需要立即清理时运行 codexc metrics cleanup。\n");
  return {
    storage: { retention_days: next.retentionDays, max_rows: next.maxRows },
    configPath: result.configPath,
    activation: result.activation,
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
  restartGateway,
  restartWebui,
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
  const deviceName = await prompts.text({
    message: "设备名称（可留空，默认使用系统名称）",
    initialValue: "",
    validate: (input) => {
      const value = String(input).trim();
      return value.length <= 128 ? undefined : "设备名称最长 128 个字符";
    },
  });
  if (prompts.isCancel(deviceName)) return { action: "back" };
  const normalizedDeviceName = String(deviceName).trim();

  const settings = loadGatewaySettings(environment);
  const result = updateGatewaySetting({
    kind: "metrics.connect",
    endpoint: base,
    deviceToken: normalizedDeviceToken,
    viewToken: normalizedViewToken,
    deviceId: null,
    deviceName: normalizedDeviceName || null,
  }, {
    environment,
    expectedRevision: settings.revision,
    writeConfig,
  });
  output.write(`已接入中心：${base}\n`);
  output.write(`设备名称：${normalizedDeviceName || hostname()}${normalizedDeviceName ? "" : "（系统主机名）"}\n`);
  output.write("配置已写入并备份。\n");
  if (result.activation === "none") {
    writeGatewayConfigActivationNotice(output, environment, "none");
  } else if (restartGateway === undefined || restartWebui === undefined) {
    writeGatewayConfigActivationNotice(output, environment, "restart");
  }
  if (result.activation !== "none") {
    await applyMetricsConsumers({ output, restartGateway, restartWebui });
  }
  return {
    endpoint: base,
    deviceId: null,
    ...(normalizedDeviceName ? { deviceName: normalizedDeviceName } : {}),
    configPath: result.configPath,
    activation: result.activation,
  };
}

async function runMetricsStatus({ environment, output }) {
  const metrics = loadGatewaySettings(environment).metrics;
  output.write(`上报：${metrics.sync.enabled ? "已启用" : "已停用"}\n`);
  output.write(`上报端点：${metrics.sync.endpoint ?? "未配置"}\n`);
  output.write(`设备 ID：${metrics.sync.deviceId ?? "自动生成"}\n`);
  output.write(`设备名称：${metrics.sync.deviceName ?? `${hostname()}（系统主机名）`}\n`);
  output.write(`上报间隔：${metrics.sync.intervalSeconds} 秒\n`);
  output.write(`单批上限：${metrics.sync.batchSize} 条\n`);
  output.write(`WebUI 全局视图：${metrics.view.enabled ? "已启用" : "已停用"}\n`);
  output.write(`查看端点：${metrics.view.endpoint ?? "未配置"}\n`);
  output.write(`设备上报令牌：${metrics.sync.deviceTokenConfigured ? "已配置" : "未配置"}\n`);
  output.write(`全局查看令牌：${metrics.view.tokenConfigured ? "已配置" : "未配置"}\n`);
  const center = metrics.center;
  const centerHost = center.host === "0.0.0.0" ? "127.0.0.1" : center.host;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const startedAt = Date.now();
  let running;
  try {
    const response = await fetch(`http://${centerHost.includes(":") ? `[${centerHost}]` : centerHost}:${center.port}/api/health`, {
      signal: controller.signal,
    });
    running = response.ok;
  } catch {
    running = false;
  } finally {
    clearTimeout(timeout);
  }
  output.write(`数据中心服务：${running ? `运行中（${Date.now() - startedAt} ms）` : "未运行或不可达"}\n`);
  output.write(`数据中心监听：${center.host}:${center.port}\n`);
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
        { value: "back", label: "返回", hint: "返回数据中心菜单" },
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
      writeGatewayConfigActivationNotice(output, environment, result.activation === "none" ? "none" : "restart");
      return { sync: { interval_seconds: parsed }, configPath: result.configPath, activation: result.activation };
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
      writeGatewayConfigActivationNotice(output, environment, result.activation === "none" ? "none" : "restart");
      return { sync: { batch_size: parsed }, configPath: result.configPath, activation: result.activation };
    } else {
      throw new Error(`未知上报参数：${String(section)}`);
    }
  }
}

async function runDisableConnection({ environment, output, writeConfig, restartGateway, restartWebui }) {
  const settings = loadGatewaySettings(environment);
  const result = updateGatewaySetting({ kind: "metrics.disconnect" }, {
    environment,
    expectedRevision: settings.revision,
    writeConfig,
  });
  output.write("已停用中心接入（本机数据中心，配置保留，可在「数据中心」中重新配置）。\n");
  if (result.activation === "none") {
    writeGatewayConfigActivationNotice(output, environment, "none");
  } else if (restartGateway === undefined || restartWebui === undefined) {
    writeGatewayConfigActivationNotice(output, environment, "restart");
  }
  if (result.activation !== "none") {
    await applyMetricsConsumers({ output, restartGateway, restartWebui });
  }
  return { disabled: true, configPath: result.configPath, activation: result.activation };
}

async function applyMetricsConsumers({ output, restartGateway, restartWebui }) {
  if (restartGateway === undefined || restartWebui === undefined) {
    output.write("本次变更同时影响 Gateway 与 WebUI；请执行 codexc service restart gateway 和 codexc service restart webui。\n");
    return;
  }
  try {
    await restartGateway();
    await restartWebui();
    output.write("Gateway 与 WebUI 已自动重启并加载数据中心配置。\n");
  } catch (error) {
    output.write("配置已保存，但 Gateway 或 WebUI 自动重启失败；请手动执行上述重启命令。\n");
    throw error;
  }
}

export async function runCenterSettings({
  environment,
  output,
  prompts,
  writeConfig,
  restartCenter,
}) {
  while (true) {
    const settings = loadGatewaySettings(environment);
    const center = settings.metrics.center;
    const section = await prompts.select({
      message: "选择数据中心服务（本机）",
      showInstructions: false,
      options: [
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
        { value: "generate_tokens", label: "生成并替换中心令牌", hint: "生成设备上报令牌和全局查看令牌" },
        {
          value: "database_path",
          label: "数据库路径",
          hint: `当前：${center.databasePath}`,
        },
        { value: "back", label: "返回", hint: "返回数据中心菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") {
      return { action: "back" };
    }
    let input;
    if (section === "host") {
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
    } else if (section === "generate_tokens") {
      const confirm = await prompts.confirm({ message: "将生成新的设备上报令牌和全局查看令牌，旧令牌立即失效。已接入设备需要重新配置，是否继续？", initialValue: false });
      if (prompts.isCancel(confirm) || !confirm) continue;
      input = { kind: "metrics.center.generate-tokens" };
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
    if (result.generatedTokens) {
      output.write(`设备上报令牌：${result.generatedTokens.deviceToken}\n`);
      output.write(`全局查看令牌：${result.generatedTokens.viewToken}\n`);
      output.write("请将设备上报令牌填入各设备的“设备上报令牌”，将全局查看令牌填入“全局查看令牌”。\n");
      output.write("请立即保存这两组令牌；旧令牌已失效。\n");
    }
    if (result.activation === "none") {
      writeGatewayConfigActivationNotice(output, environment, "none");
    } else if (restartCenter !== undefined) {
      try {
        await restartCenter();
        output.write("配置已保存，数据中心已自动重启并加载新配置。\n");
      } catch (error) {
        output.write("配置已保存，但数据中心自动重启失败，请手动执行：codexc service restart center\n");
        throw error;
      }
    } else {
      output.write("配置已保存，请执行：codexc service restart center\n");
    }
    return {
      center: result.value.center,
      configPath: result.configPath,
      activation: result.activation,
      ...(result.generatedTokens === undefined ? {} : { generatedTokens: result.generatedTokens }),
    };
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
