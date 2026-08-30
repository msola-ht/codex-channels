import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

import { loadRuntimeConfig } from "../dist/config/index.js";
import {
  securePrivateDirectorySync,
  writePrivateFileAtomicSync,
} from "../runtime/private-file.mjs";
import { assertSynchronousChildSuccess } from "../runtime/process-lifecycle.mjs";
import { resolveExecutable } from "../runtime/executable.mjs";
import { serviceDefinitions } from "../runtime/service-targets.mjs";
import { packageDir } from "./package-path.mjs";
import {
  ensureServiceInstallRuntimeDirectory,
  resolveServiceInstallContext,
} from "./service-install-context.mjs";

const platformDefinitions = {
  linux: {
    serviceManager: "systemd",
    shell: "/bin/sh",
    controlScript: "systemd-control.sh",
    additionalPathEntries: [
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/local/sbin",
      "/usr/sbin",
      "/sbin",
    ],
  },
  darwin: {
    serviceManager: "launchd",
    shell: "/bin/zsh",
    controlScript: "launchd-control.sh",
    additionalPathEntries: [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ],
  },
  win32: {
    serviceManager: "windows",
    shell: process.execPath,
    controlScript: "windows-service-control.mjs",
    additionalPathEntries: [],
  },
};

const stageLabels = {
  "validate-config": "配置校验",
  preflight: "平台预检",
  "write-definitions": "服务定义写入",
  "activate-core": "核心服务激活",
  "verify-core": "核心服务就绪确认",
};

export class ServiceInstallManagementError extends Error {
  constructor(code, stage, message, details = {}, options = {}) {
    super(message, options);
    this.name = "ServiceInstallManagementError";
    this.code = code;
    this.stage = stage;
    this.completedStages = [...(details.completedStages ?? [])];
    this.recovery = details.recovery ?? "retry-install";
  }
}

export function previewServiceInstall(
  environment = process.env,
  options = {},
) {
  return publicPlan(buildServiceInstallPlan(environment, options));
}

export function prepareServiceInstall(
  environment = process.env,
  options = {},
) {
  const plan = buildServiceInstallPlan(environment, options);
  return {
    preview: publicPlan(plan),
    execute: (executionOptions = {}) => executePlan(
      plan,
      environment,
      { ...options, ...executionOptions },
    ),
  };
}

export async function installServices(
  environment = process.env,
  options = {},
) {
  return prepareServiceInstall(environment, options).execute();
}

export function writeServiceDefinitions(
  environment = process.env,
  options = {},
) {
  const plan = buildServiceInstallPlan(environment, options);
  writeDefinitions(plan, options);
  return definitionResult(plan);
}

async function executePlan(plan, environment, options) {
  assertFreshPlan(plan, environment, options);
  const completedStages = [];
  const executeStage = async (stage, operation) => {
    emitProgress(options, plan, stage, "started", completedStages);
    try {
      await operation();
      completedStages.push(stage);
      emitProgress(options, plan, stage, "completed", completedStages);
    } catch (error) {
      emitProgress(options, plan, stage, "failed", completedStages);
      throw installFailure(stage, error, completedStages);
    }
  };

  await executeStage("validate-config", () =>
    (options.validateConfig ?? loadRuntimeConfig)(environment));
  await executeStage("preflight", () =>
    (options.preflight ?? defaultPreflight)(plan, environment, options));
  await executeStage("write-definitions", () => writeDefinitions(plan, options));
  await executeStage("activate-core", () =>
    (options.activateCore ?? defaultActivateCore)(plan, environment, options));
  await executeStage("verify-core", () =>
    (options.waitForCore ?? defaultWaitForCore)(
      "all",
      environment,
      options.readinessOptions,
    ));

  return {
    action: "installed",
    ...publicPlan(plan),
    completedStages,
  };
}

function buildServiceInstallPlan(environment, options) {
  const operatingSystem = options.operatingSystem ?? process.platform;
  const definition = Object.hasOwn(platformDefinitions, operatingSystem)
    ? platformDefinitions[operatingSystem]
    : undefined;
  if (!definition) {
    throw new ServiceInstallManagementError(
      "unsupported-platform",
      "preflight",
      "后台服务当前支持 macOS launchd、Linux systemd 与 Windows 计划任务",
      { completedStages: [], recovery: "unsupported" },
    );
  }
  const home = operatingSystem === "win32"
    ? stringValue(environment.USERPROFILE)
    : stringValue(environment.HOME);
  if (!home) {
    throw new ServiceInstallManagementError(
      "missing-home",
      "preflight",
      `无法生成后台服务安装计划：${operatingSystem === "win32" ? "USERPROFILE" : "HOME"} 未设置`,
      { completedStages: [], recovery: "set-home" },
    );
  }
  const projectDir = options.projectDir ?? packageDir;
  const baseContext = resolveServiceInstallContext(
    definition.additionalPathEntries,
    {
      environment,
      projectDir,
      ...(options.nodeExecutable === undefined
        ? {}
        : { nodeExecutable: options.nodeExecutable }),
    },
  );
  const context = definition.serviceManager === "windows"
    ? {
        ...baseContext,
        pwshBinary: options.pwshExecutable
          ?? resolveExecutable("pwsh.exe", environment),
      }
    : baseContext;
  const destinationDirectory = definition.serviceManager === "systemd"
    ? join(
        stringValue(environment.XDG_CONFIG_HOME)
          ? resolve(environment.XDG_CONFIG_HOME)
          : join(resolve(home), ".config"),
        "systemd",
        "user",
      )
    : definition.serviceManager === "launchd"
      ? join(resolve(home), "Library", "LaunchAgents")
      : join(context.runtime.dataDir, "services");
  const files = serviceDefinitions.map((service) => {
    const identifier = service[definition.serviceManager];
    const templatePath = definition.serviceManager === "systemd"
      ? join(projectDir, "systemd", identifier)
        .replace(/\.service$/u, ".service.template")
      : definition.serviceManager === "launchd"
        ? join(projectDir, "launchd", `${identifier}.plist.template`)
        : undefined;
    const destination = definition.serviceManager === "systemd"
      ? join(destinationDirectory, identifier)
      : definition.serviceManager === "launchd"
        ? join(destinationDirectory, `${identifier}.plist`)
        : join(destinationDirectory, `${service.target}.json`);
    const template = templatePath ? readFileSync(templatePath, "utf8") : undefined;
    return {
      service,
      identifier,
      destination,
      content: definition.serviceManager === "systemd"
        ? renderSystemdTemplate(template, context)
        : definition.serviceManager === "launchd"
          ? renderLaunchdTemplate(template, context)
          : renderWindowsDefinition(service, identifier, context, projectDir),
    };
  });
  const plan = {
    operatingSystem,
    serviceManager: definition.serviceManager,
    controlScript: join(projectDir, "scripts", definition.controlScript),
    shell: definition.shell,
    context,
    destinationDirectory,
    files,
    steps: [
      "validate-config",
      "preflight",
      "write-definitions",
      "activate-core",
      "verify-core",
    ],
  };
  plan.revision = planRevision(plan);
  return plan;
}

function publicPlan(plan) {
  return {
    operation: "install",
    revision: plan.revision,
    operatingSystem: plan.operatingSystem,
    serviceManager: plan.serviceManager,
    configPath: plan.context.runtime.configPath,
    services: plan.files.map(({ service, identifier, destination }) => ({
      target: service.target,
      displayName: service.displayName,
      identifier,
      destination,
      startsOnInstall: service.core,
    })),
    steps: [...plan.steps],
    activation: "none",
  };
}

function definitionResult(plan) {
  return {
    action: "definitions-written",
    revision: plan.revision,
    operatingSystem: plan.operatingSystem,
    serviceManager: plan.serviceManager,
    services: publicPlan(plan).services,
  };
}

function assertFreshPlan(plan, environment, options) {
  const current = buildServiceInstallPlan(environment, options);
  if (current.revision !== plan.revision) {
    throw new ServiceInstallManagementError(
      "stale-plan",
      "preflight",
      "后台服务配置或模板已变化，请重新生成安装计划",
      { completedStages: [], recovery: "recreate-plan" },
    );
  }
}

function writeDefinitions(plan, options) {
  ensureServiceInstallRuntimeDirectory(plan.context);
  mkdirSync(plan.destinationDirectory, { recursive: true, mode: 0o700 });
  if (plan.serviceManager === "windows") {
    securePrivateDirectorySync(plan.destinationDirectory);
  }
  const writer = options.writeDefinition ?? writePrivateFileAtomicSync;
  for (const file of plan.files) writer(file.destination, file.content);
}

function defaultPreflight(plan, environment, options) {
  if (plan.serviceManager === "launchd") {
    runController(plan, "check-install", environment, options);
  }
  if (plan.serviceManager === "windows") {
    runController(plan, "preflight", environment, options);
  }
}

function defaultActivateCore(plan, environment, options) {
  runController(plan, "install", environment, options);
}

async function defaultWaitForCore(target, environment, options) {
  const { waitForCoreServiceTarget } = await import("./local-update.mjs");
  return waitForCoreServiceTarget(target, environment, options);
}

function runController(plan, action, environment, options) {
  const args = plan.serviceManager === "windows"
    ? [plan.controlScript, action, "--definitions", plan.destinationDirectory]
    : [plan.controlScript, action];
  const result = (options.spawnCommand ?? spawnSync)(
    plan.shell,
    args,
    {
      cwd: plan.context.runtime.dataDir,
      env: environment,
      stdio: options.controllerStdio ?? "inherit",
    },
  );
  assertSynchronousChildSuccess(result, { failureReportedByChild: true });
}

function renderWindowsDefinition(service, identifier, context, projectDir) {
  const command = service.target === "app-server" ? "service-app-server" : service.target;
  const environment = {
    CODEX_CONNECT_HOME: context.runtime.dataDir,
    CODEX_CONNECT_CONFIG_FILE: context.runtime.configPath,
    PATH: [context.executablePath, dirname(context.pwshBinary)].join(delimiter),
    ...(service.target === "app-server"
      ? { CODEX_CONNECT_SERVICE_ROLE: "app-server" }
      : {}),
    ...(service.target === "gateway"
      ? {
          CODEX_CONNECT_SERVICE_ROLE: "gateway",
          CODEX_CONNECT_GATEWAY_SUPERVISED: "1",
          CODEX_BINARY: context.codexBinary,
        }
      : {}),
  };
  const logBase = service.target === "app-server" ? "codex-app-server" : service.target;
  return `${JSON.stringify({
    version: 1,
    target: service.target,
    displayName: service.displayName,
    description: `${service.displayName} background service for Codex Connect`,
    taskName: identifier,
    pwshBinary: context.pwshBinary,
    launcherPath: join(projectDir, "scripts", "windows-service-launcher.ps1"),
    nodeBinary: context.nodeBinary,
    serviceHost: join(projectDir, "scripts", "windows-service-host.mjs"),
    arguments: [
      "--disable-warning=ExperimentalWarning",
      context.cliEntry,
      command,
    ],
    workingDirectory: service.target === "app-server"
      ? context.workdir
      : context.runtime.dataDir,
    environment,
    controlPath: join(context.runtimeDir, `windows-service-${service.target}.sock`),
    stdoutLog: join(context.runtimeDir, `${logBase}.log`),
    stderrLog: join(context.runtimeDir, `${logBase}.error.log`),
  }, null, 2)}\n`;
}

function renderSystemdTemplate(template, context) {
  const argumentValues = {
    SOCKET_URI: `unix://${context.socketPath}`,
    NODE_BINARY: context.nodeBinary,
    CODEX_BINARY: context.codexBinary,
    CLI_ENTRY: context.cliEntry,
  };
  const directiveValues = {
    WORKDIR: context.workdir,
    CONFIG_DIR: context.runtime.dataDir,
  };
  const environmentValues = {
    CONFIG_DIR_ENV: context.runtime.dataDir,
    CONFIG_PATH_ENV: context.runtime.configPath,
    CODEX_BINARY_ENV: context.codexBinary,
    SYSTEMD_PATH: context.executablePath,
  };
  let rendered = replaceValues(
    template,
    argumentValues,
    (value) => `"${systemdEscape(value)}"`,
  );
  rendered = replaceValues(rendered, directiveValues, systemdEscape);
  return replaceValues(rendered, environmentValues, systemdEscape);
}

function renderLaunchdTemplate(template, context) {
  return replaceValues(template, {
    PROJECT_DIR: context.packageDir,
    CONFIG_DIR: context.runtime.dataDir,
    CONFIG_PATH: context.runtime.configPath,
    CLI_ENTRY: context.cliEntry,
    WORKDIR: context.workdir,
    RUNTIME_DIR: context.runtimeDir,
    SOCKET_PATH: context.socketPath,
    NODE_BINARY: context.nodeBinary,
    CODEX_BINARY: context.codexBinary,
    LAUNCHD_PATH: context.executablePath,
  }, xmlEscape);
}

function replaceValues(template, values, escape) {
  return Object.entries(values).reduce(
    (content, [key, value]) =>
      content.replaceAll(`__${key}__`, escape(value)),
    template,
  );
}

function systemdEscape(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function planRevision(plan) {
  return createHash("sha256").update(JSON.stringify({
    operatingSystem: plan.operatingSystem,
    serviceManager: plan.serviceManager,
    context: plan.context,
    files: plan.files.map(({ identifier, destination, content }) => ({
      identifier,
      destination,
      content,
    })),
  })).digest("hex");
}

function emitProgress(options, plan, stage, status, completedStages) {
  try {
    options.onProgress?.({
      operation: "install",
      revision: plan.revision,
      stage,
      status,
      completedStages: [...completedStages],
    });
  } catch {
    // 进度观察者不得中断服务安装事务。
  }
}

function installFailure(stage, error, completedStages) {
  if (error instanceof ServiceInstallManagementError) return error;
  const recovery = stage === "verify-core"
    ? "inspect-services"
    : stage === "write-definitions"
      || completedStages.includes("write-definitions")
      ? "retry-install"
      : "fix-and-retry";
  return new ServiceInstallManagementError(
    "install-stage-failed",
    stage,
    `后台服务安装在“${stageLabels[stage]}”阶段失败：${errorMessage(error)}`,
    { completedStages, recovery },
    { cause: error },
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
