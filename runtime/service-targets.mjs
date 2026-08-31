export const serviceDefinitions = Object.freeze([
  Object.freeze({
    target: "app-server",
    displayName: "Codex App Server",
    systemd: "codex-connect-app-server.service",
    launchd: "com.hegenai.codex-app-server",
    windows: "Codex Connect App Server",
    core: true,
    helpOrder: 1,
    startOrder: 0,
    stopOrder: 1,
  }),
  Object.freeze({
    target: "gateway",
    displayName: "Gateway",
    systemd: "codex-connect-gateway.service",
    launchd: "com.hegenai.codex-gateway",
    windows: "Codex Connect Gateway",
    core: true,
    helpOrder: 0,
    startOrder: 1,
    stopOrder: 0,
  }),
  Object.freeze({
    target: "webui",
    displayName: "WebUI",
    systemd: "codex-connect-webui.service",
    launchd: "com.hegenai.codex-webui",
    windows: "Codex Connect WebUI",
    core: false,
    helpOrder: 2,
    startOrder: 0,
    stopOrder: 0,
  }),
  Object.freeze({
    target: "center",
    displayName: "指标中心",
    systemd: "codex-connect-center.service",
    launchd: "com.hegenai.codex-center",
    windows: "Codex Connect Metrics Center",
    core: false,
    helpOrder: 3,
    startOrder: 0,
    stopOrder: 0,
  }),
]);

export const serviceTargetUsage = [
  ...[...serviceDefinitions]
    .sort((left, right) => left.helpOrder - right.helpOrder)
    .map((definition) => definition.target),
  "all",
].join("|");

export function parseServiceTarget(value) {
  if (value === "all" || serviceDefinitions.some((item) => item.target === value)) {
    return value;
  }
  throw new Error(
    `服务目标必须是 ${serviceTargetUsage.replaceAll("|", "、")}：${value}`,
  );
}

export function defaultServiceTarget(action) {
  return action === "restart" || action === "logs" ? "gateway" : "all";
}

export function serviceTargetIncludes(target, expected) {
  const parsed = parseServiceTarget(target);
  return parsed === expected
    || (parsed === "all" && serviceDefinitions.some((item) =>
      item.core && item.target === expected));
}

export function serviceDefinitionsForTarget(target, order = "start") {
  const parsed = parseServiceTarget(target);
  if (order !== "start" && order !== "stop") {
    throw new Error(`服务顺序必须是 start 或 stop：${order}`);
  }
  const selected = parsed === "all"
    ? serviceDefinitions.filter((definition) => definition.core)
    : serviceDefinitions.filter((definition) => definition.target === parsed);
  const orderKey = order === "stop" ? "stopOrder" : "startOrder";
  return [...selected].sort((left, right) => left[orderKey] - right[orderKey]);
}

export function serviceIdentifiers(platform, target = "all", order = "start") {
  if (platform !== "systemd" && platform !== "launchd" && platform !== "windows") {
    throw new Error(`不支持的服务平台：${platform}`);
  }
  return serviceDefinitionsForTarget(target, order).map((definition) => definition[platform]);
}
