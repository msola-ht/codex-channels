import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { serviceDefinitions } from "../runtime/service-targets.mjs";
import { prepareServiceInstallContext } from "./service-install-context.mjs";

try {
  installLaunchdAgents();
} catch (error) {
  writeCliMessage("failure", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function installLaunchdAgents() {
  if (process.platform !== "darwin") {
    throw new Error("launchd 安装仅支持 macOS");
  }
  const {
    cliEntry,
    codexBinary,
    executablePath: launchdPath,
    nodeBinary,
    packageDir: projectDir,
    runtime,
    runtimeDir,
    socketPath,
    workdir,
  } = prepareServiceInstallContext([
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]);
  const values = {
    PROJECT_DIR: projectDir,
    CONFIG_DIR: runtime.dataDir,
    CONFIG_PATH: runtime.configPath,
    CLI_ENTRY: cliEntry,
    WORKDIR: workdir,
    RUNTIME_DIR: runtimeDir,
    SOCKET_PATH: socketPath,
    NODE_BINARY: nodeBinary,
    CODEX_BINARY: codexBinary,
    LAUNCHD_PATH: launchdPath,
  };
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });
  for (const definition of serviceDefinitions) {
    const name = definition.launchd;
    const template = readFileSync(join(projectDir, "launchd", `${name}.plist.template`), "utf8");
    const rendered = Object.entries(values).reduce(
      (content, [key, value]) => content.replaceAll(`__${key}__`, xmlEscape(value)),
      template,
    );
    const destination = join(agentsDir, `${name}.plist`);
    writeFileSync(destination, rendered, { mode: 0o600 });
    console.log(`生成：${destination}`);
  }
  writeCliMessage("success", "launchd 配置已生成。");
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
