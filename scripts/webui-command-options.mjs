export const WEBUI_USAGE = "用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]";

export function assertWebuiHost(value) {
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(value)) {
    throw new Error("WebUI host 只允许 127.0.0.1、::1 或 0.0.0.0");
  }
}

export function parseWebuiCliArgs(args) {
  const settings = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      const raw = args[index + 1];
      if (raw === undefined || !/^[0-9]+$/u.test(raw)) {
        throw new Error(WEBUI_USAGE);
      }
      const port = Number(raw);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("端口必须在 1 到 65535 之间");
      }
      settings.port = port;
      index += 1;
      continue;
    }
    if (argument === "--host") {
      const raw = args[index + 1];
      if (raw === undefined) {
        throw new Error(WEBUI_USAGE);
      }
      assertWebuiHost(raw);
      settings.host = raw;
      index += 1;
      continue;
    }
    if (argument === "--token") {
      const raw = args[index + 1];
      if (raw === undefined || raw === "" || raw.startsWith("--")) {
        throw new Error(WEBUI_USAGE);
      }
      settings.token = raw;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}\n${WEBUI_USAGE}`);
  }
  return settings;
}
