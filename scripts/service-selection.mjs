import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readGatewayConfig,
  validateGatewayConfigDocument,
  validateWebuiConfigDocument,
} from "../runtime/gateway-config.mjs";
import { serviceDefinitionsForTarget } from "../runtime/service-targets.mjs";
import { locateUserConfig } from "./runtime-config.mjs";
import { queryModelRelayControl } from "../runtime/model-relay-control.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";

export function serviceDefinitionPath(platform, definition, environment = process.env, definitionsDirectory) {
  const home = environment.HOME || environment.USERPROFILE || homedir();
  if (platform === "systemd") return join(environment.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", definition.systemd);
  if (platform === "launchd") return join(home, "Library", "LaunchAgents", `${definition.launchd}.plist`);
  if (platform === "windows") return join(definitionsDirectory ?? join(environment.CODEX_CONNECT_HOME || join(home, ".codex-connect"), "services"), `${definition.target}.json`);
  throw new Error(`不支持的服务平台：${platform}`);
}

/** All includes installed optional services; installation preserves WebUI's running state. */
export function serviceControlDefinitions(platform, target, order = "start", environment = process.env, definitionsDirectory) {
  const selected = serviceDefinitionsForTarget(target, ["stop", "install-stop", "uninstall"].includes(order) ? "stop" : "start");
  if (target !== "all" || order === "uninstall") return selected;
  return selected.filter(definition => {
    if (definition.core) return true;
    if (definition.target === "webui" && (order === "install" || order === "install-stop")) return false;
    if (!existsSync(serviceDefinitionPath(platform, definition, environment, definitionsDirectory))) return false;
    if (definition.target === "webui" && order === "start" && configuredWebuiEnabled(environment) === false) return false;
    if (definition.target === "model-relay" && (order === "start" || order === "install")) {
      const { configPath } = locateUserConfig(environment);
      return validateGatewayConfigDocument(readGatewayConfig(configPath)).model_relay?.enabled === true;
    }
    return true;
  });
}

/**
 * 启动选择按 [webui] 段严格判定：配置无效时失败关闭，
 * 不把未知取值当作“未设置”而重新启动用户已关闭的服务。
 */
function configuredWebuiEnabled(environment) {
  const { configPath } = locateUserConfig(environment);
  return validateWebuiConfigDocument(readGatewayConfig(configPath)).enabled;
}

/**
 * 状态判定用的“预期运行”集合：启动选择必须读配置并失败关闭，状态查询不能因此中断，
 * 因此配置不可读时退回“已安装的可选服务按必需判定”的既有语义，并在 stderr 说明降级。
 */
export function serviceStatusRequiredDefinitions(
  platform,
  target,
  environment = process.env,
  definitionsDirectory,
) {
  try {
    return serviceControlDefinitions(platform, target, "start", environment, definitionsDirectory);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "";
    process.stderr.write(`无法读取或校验配置${detail === "" ? "" : `（${detail}）`}，已安装的可选服务按必需判定。\n`);
    return serviceControlDefinitions(platform, target, "status", environment, definitionsDirectory);
  }
}

export function serviceSnapshotHealthy(services, target, environment = process.env) {
  return services.every(service => {
    if (service.running) return true;
    if (target !== "all") return false;
    if (service.target === "webui") {
      // 配置中关闭的 WebUI 允许保持停止；配置不可读或无效时仍按异常报告。
      try {
        return configuredWebuiEnabled(environment) === false;
      } catch {
        return false;
      }
    }
    if (service.target !== "model-relay") return false;
    try {
      const { configPath } = locateUserConfig(environment);
      return validateGatewayConfigDocument(readGatewayConfig(configPath)).model_relay?.enabled !== true;
    } catch { return false; }
  });
}

export async function waitForSelectedRelay(target, environment = process.env) {
  const platform = process.platform === "linux" ? "systemd" : process.platform === "darwin" ? "launchd" : "windows";
  if (!serviceControlDefinitions(platform, target, "start", environment).some(value => value.target === "model-relay")) return;
  const { configPath } = locateUserConfig(environment);
  const enabled = validateGatewayConfigDocument(readGatewayConfig(configPath)).model_relay?.enabled === true;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await queryModelRelayControl(modelRelayPaths(configPath).control, "status");
    if (status.result === "status" && status.configurationValid === true && status.enabled === enabled && status.listening === enabled) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Model Relay 未就绪；请检查 codexc relay status 与服务日志");
}
