import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parse } from "dotenv";
import WebSocket from "ws";

import { packageDir, resolveConfiguredPath, userDataDir } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const checks = [];
const packageMetadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const protocolMetadata = JSON.parse(
  readFileSync(join(packageDir, "src", "codex-protocol", "version.json"), "utf8"),
);

record("Codex Connect", true, `${packageMetadata.name}@${packageMetadata.version}`);
record(
  "Node.js",
  versionAtLeast(process.versions.node, "22.13.0"),
  `${process.version}（要求 >=22.13.0）`,
);

const explicitEnvFile = process.env.CODEX_CONNECT_ENV_FILE?.trim();
const dataDir = explicitEnvFile ? dirname(resolve(explicitEnvFile)) : userDataDir();
const envPath = explicitEnvFile ? resolve(explicitEnvFile) : join(dataDir, ".env");
let env;

if (!existsSync(envPath)) {
  record("用户配置", false, `不存在：${envPath}；请先运行 codexc init`);
} else {
  record("用户配置", true, envPath);
  checkMode("配置目录权限", dataDir, 0o700);
  checkMode("配置文件权限", envPath, 0o600);
  env = parse(readFileSync(envPath, "utf8"));
}

if (env) {
  const tokenConfigured = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
  const allowedUsers = validAllowedUsers(env.TELEGRAM_ALLOWED_USER_IDS);
  record("Telegram Token", tokenConfigured, tokenConfigured ? "已配置（内容已隐藏）" : "未配置");
  record(
    "Telegram 用户",
    allowedUsers,
    allowedUsers ? "允许列表有效" : "TELEGRAM_ALLOWED_USER_IDS 未配置或格式无效",
  );

  try {
    const { workspaces, defaultWorkspace } = readWorkspaceConfig(env);
    record("Workspace", true, `${workspaces.length} 个，默认 ${defaultWorkspace.id}`);
  } catch (error) {
    record("Workspace", false, errorMessage(error));
  }

  const codexCommand = env.CODEX_BINARY?.trim() || "codex";
  try {
    const codexBinary = resolveExecutable(codexCommand);
    const versionResult = spawnSync(codexBinary, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (versionResult.error) {
      throw versionResult.error;
    }
    const actualVersion = versionResult.stdout.trim() || versionResult.stderr.trim();
    record(
      "Codex CLI",
      versionResult.status === 0 && actualVersion === protocolMetadata.codexCli,
      `${actualVersion || "无法读取版本"}（要求 ${protocolMetadata.codexCli}）`,
    );
  } catch (error) {
    record("Codex CLI", false, errorMessage(error));
  }

  const socketPath = resolveConfiguredPath(
    env.CODEX_SOCKET_PATH,
    dataDir,
    join(dataDir, "runtime", "codex-app-server.sock"),
  );
  if (!existsSync(socketPath)) {
    record("Codex App Server", false, `Socket 不存在：${socketPath}`);
  } else {
    try {
      await initializeUnixWebSocket(socketPath);
      record("Codex App Server", true, `initialize 握手通过：${socketPath}`);
    } catch (error) {
      record("Codex App Server", false, `连接失败：${errorMessage(error)}`);
    }
  }
}

if (process.platform === "darwin") {
  const uid = process.getuid?.();
  const domain = `gui/${uid}`;
  const labels = ["com.hegenai.codex-app-server", "com.hegenai.codex-gateway"];
  const legacyLabels = ["com.msola.codex-app-server", "com.msola.codex-gateway"];
  const loaded = labels.filter((label) =>
    spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0,
  );
  const loadedLegacy = legacyLabels.filter((label) =>
    spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0,
  );
  note(
    "launchd",
    loaded.length === labels.length
      ? "App Server 与 Gateway 已加载"
      : loadedLegacy.length > 0
        ? `检测到 ${loadedLegacy.length} 个旧版 Job；请运行 codexc service install 完成迁移`
      : `已加载 ${loaded.length}/${labels.length}；前台运行模式可忽略`,
  );
} else if (process.platform === "linux") {
  const units = ["codex-connect-app-server.service", "codex-connect-gateway.service"];
  const active = units.filter((unit) =>
    spawnSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore", timeout: 3_000 }).status === 0,
  );
  note(
    "systemd",
    active.length === units.length
      ? "App Server 与 Gateway 已运行"
      : `已运行 ${active.length}/${units.length}；可运行 codexc service install 安装用户服务`,
  );
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const linger = spawnSync("loginctl", ["show-user", String(uid), "--property=Linger", "--value"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    note(
      "systemd linger",
      linger.status === 0 && linger.stdout.trim() === "yes"
        ? "已启用，退出登录后服务可继续运行"
        : "未启用或无法确认；如需退出 SSH 后继续运行，请执行 sudo loginctl enable-linger $USER",
    );
  }
} else {
  note("系统服务", "当前平台尚未提供系统服务适配");
}

for (const check of checks) {
  console.log(`${check.prefix} ${check.name}：${check.detail}`);
}
const failures = checks.filter((check) => check.kind === "failure").length;
console.log(failures === 0 ? "\n诊断通过。" : `\n诊断发现 ${failures} 项问题。`);
process.exitCode = failures === 0 ? 0 : 1;

function record(name, passed, detail) {
  checks.push({ kind: passed ? "success" : "failure", prefix: passed ? "[通过]" : "[失败]", name, detail });
}

function note(name, detail) {
  checks.push({ kind: "note", prefix: "[提示]", name, detail });
}

function checkMode(name, path, expected) {
  try {
    const actual = statSync(path).mode & 0o777;
    record(name, actual === expected, `${actual.toString(8).padStart(3, "0")}（要求 ${expected.toString(8)}）`);
  } catch (error) {
    record(name, false, errorMessage(error));
  }
}

function validAllowedUsers(value) {
  const items = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return items.length > 0 && items.every((item) => Number.isSafeInteger(Number(item)) && Number(item) > 0);
}

function resolveExecutable(command) {
  if (isAbsolute(command)) {
    return realpathSync(command);
  }
  return realpathSync(execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim());
}

function versionAtLeast(actual, minimum) {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
}

async function initializeUnixWebSocket(socketPath) {
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      handshakeTimeout: 2_000,
      createConnection: () => createConnection(socketPath),
    });
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("initialize 握手超时")), 3_000);
    timeout.unref();
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.terminate();
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    };
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "codexc_doctor",
              title: "Codex Connect Doctor",
              version: packageMetadata.version,
            },
            capabilities: {
              experimentalApi: false,
              requestAttestation: false,
              optOutNotificationMethods: null,
            },
          },
        }),
        (error) => error && finish(error),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (message.id !== 1) {
        return;
      }
      if (message.error) {
        finish(new Error(`initialize 被拒绝：${message.error.message || "未知错误"}`));
        return;
      }
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
        (error) => finish(error),
      );
    });
    socket.once("error", finish);
    socket.once("close", () => finish(new Error("WebSocket 在握手完成前关闭")));
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
