import { serviceControlDefinitions, serviceStatusRequiredDefinitions } from "./service-selection.mjs";

const platform = process.argv[2];
const target = process.argv[3];
const order = process.argv[4];
if (
  (platform !== "systemd" && platform !== "launchd")
  || target === undefined
) {
  throw new Error(
    "用法：service-target-query.mjs <systemd|launchd> <gateway|app-server|webui|model-relay|all> [start|stop|status|status-required]",
  );
}
if (order !== undefined && !["start", "stop", "status", "status-required", "install", "install-stop", "uninstall"].includes(order)) throw new Error("未知服务选择操作");
const definitions = order === "status-required"
  ? serviceStatusRequiredDefinitions(platform, target)
  : serviceControlDefinitions(platform, target, order);
const identifiers = definitions.map(service => service[platform]);
for (const identifier of identifiers) {
  console.log(identifier);
}
