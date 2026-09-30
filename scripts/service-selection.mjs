import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readGatewayConfig, validateGatewayConfigDocument } from "../runtime/gateway-config.mjs";
import { serviceDefinitions, serviceDefinitionsForTarget } from "../runtime/service-targets.mjs";
import { locateUserConfig } from "./runtime-config.mjs";
import { queryModelRelayControl } from "../runtime/model-relay-control.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";

/** Optional Relay joins all only when installed; starting also requires explicit enablement. */
export function serviceControlDefinitions(platform, target, order = "start", environment = process.env, definitionsDirectory) {
  const selected = serviceDefinitionsForTarget(target, order === "stop" ? "stop" : "start");
  if (target !== "all") return selected;
  const relay = serviceDefinitions.find(value => value.target === "model-relay");
  const home = environment.HOME || environment.USERPROFILE || homedir();
  const definitionPath = platform === "systemd"
    ? join(environment.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", relay.systemd)
    : platform === "launchd" ? join(home, "Library", "LaunchAgents", `${relay.launchd}.plist`)
      : join(definitionsDirectory ?? join(environment.CODEX_CONNECT_HOME || join(home, ".codex-connect"), "services"), "model-relay.json");
  if (!existsSync(definitionPath)) return selected;
  if (order === "start") {
    const { configPath } = locateUserConfig(environment);
    const document = validateGatewayConfigDocument(readGatewayConfig(configPath));
    if (document.model_relay?.enabled !== true) return selected;
  }
  return order === "stop" ? [relay, ...selected] : [...selected, relay];
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
