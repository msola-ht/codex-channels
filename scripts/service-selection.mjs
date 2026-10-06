import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readGatewayConfig, validateGatewayConfigDocument } from "../runtime/gateway-config.mjs";
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
    if (definition.target === "model-relay" && (order === "start" || order === "install")) {
      const { configPath } = locateUserConfig(environment);
      return validateGatewayConfigDocument(readGatewayConfig(configPath)).model_relay?.enabled === true;
    }
    return true;
  });
}

export function serviceSnapshotHealthy(services, target, environment = process.env) {
  return services.every(service => {
    if (service.running) return true;
    if (target !== "all" || service.target !== "model-relay") return false;
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
