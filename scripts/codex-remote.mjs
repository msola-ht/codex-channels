import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { parse } from "smol-toml";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { loadAutoReviewProviderPolicy } from "../runtime/auto-review-provider-policy.mjs";
import {
  acquireAppServerProviderLease,
  inspectAppServerSupervisor,
} from "../runtime/app-server-supervisor.mjs";
import {
  loadConfiguredCustomSwitchingModelProviders,
  loadManagedModelProviders,
  providerAppServerSocketPath,
} from "../runtime/model-provider-runtime.mjs";
import {
  loadManagedModelProviderDefinitions,
} from "../runtime/model-provider-definitions.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import {
  assertSynchronousChildSuccess,
  ForwardedChildSignalError,
  ReportedChildExitError,
} from "../runtime/process-lifecycle.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { defaultCodexRemoteProfile, parseCodexRemoteOptions } from "./codex-remote-options.mjs";
import { runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

try {
  await runRemoteCli();
} catch (error) {
  if (error instanceof ReportedChildExitError) {
    writeCliMessage("failure", error.message);
    process.exitCode = error.exitCode;
  } else if (!(error instanceof ForwardedChildSignalError)) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runRemoteCli() {
  const runtime = runtimeConfig();
  const document = readGatewayConfig(runtime.configPath);
  const codex = table(document.codex);
  const { workspaces } = readWorkspaceConfig(document);
  const customSwitchingProviders = loadConfiguredCustomSwitchingModelProviders();
  const { passthrough, selectedProfile, selectedProvider, workspaceId } = parseCodexRemoteOptions(
    process.argv.slice(2),
    {
      selectDefaultProfile: defaultCodexRemoteProfile,
      customSwitchingProfiles: customSwitchingProviders.map(
        ({ provider, profileName }) => ({
          providerId: provider,
          profileName,
        }),
      ),
    },
  );
  let workdir = realpathSync(process.cwd());
  let workspace = workspaceForWorkdir(workspaces, workdir);
  if (workspaceId !== undefined) {
    workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new Error(`找不到 Workspace：${workspaceId}`);
    }
    workdir = workspace.cwd;
  }
  const appServer = resolveAppServerRuntime(document, runtime.dataDir);
  const { primarySocketPath } = appServer;
  let socketPath = primarySocketPath;
  let providerLease;
  let leaseProvider = appServer.primaryProvider;
  const customSwitchingProvider = customSwitchingProviders.find(
    ({ profileName }) => profileName === selectedProfile,
  );
  const selectedDefinition = customSwitchingProvider !== undefined
    ? {
        id: customSwitchingProvider.provider,
        profileName: customSwitchingProvider.profileName,
        displayName: customSwitchingProvider.provider,
      }
    : [
    ...loadManagedModelProviderDefinitions(process.env),
    ].find(({ profileName }) => profileName === selectedProfile);
  if (selectedProfile !== undefined && selectedDefinition === undefined) {
    throw new Error(`模型 Provider Profile ${selectedProfile} 已不再可用`);
  }
  if (selectedDefinition) {
    const managedProvider = customSwitchingProvider?.provider === selectedDefinition.id
      ? customSwitchingProvider
      : loadManagedModelProviders().find(
          ({ provider }) => provider === selectedDefinition.id,
        );
    if (!managedProvider) {
      throw new Error(`${selectedDefinition.displayName} 尚未配置，请先运行 codexc setup`);
    }
    socketPath = providerAppServerSocketPath(primarySocketPath, managedProvider.provider);
    leaseProvider = managedProvider.provider;
  }
  if (selectedProvider !== undefined) {
    if (!appServer.managedProviders.some(({ provider }) => provider === selectedProvider)) {
      throw new Error("聚合实例尚不可用；需要至少两个已配置的 API Key 切换提供商");
    }
    socketPath = providerAppServerSocketPath(primarySocketPath, selectedProvider);
    leaseProvider = selectedProvider;
    assertAggregateProviderArguments(passthrough);
  }
  const autoReviewSupported = selectedProvider === undefined
    || loadAutoReviewProviderPolicy().supportedProviders.has(selectedProvider);
  const permissionArguments = workspacePermissionArguments(workspace, passthrough, autoReviewSupported);
  const configuredBinary = stringValue(codex.binary) || "codex";
  const supervisorActive = selectedDefinition !== undefined || selectedProvider !== undefined
    || await inspectAppServerSupervisor(primarySocketPath) !== undefined;
  try {
    if (supervisorActive) {
      providerLease = await acquireAppServerProviderLease(primarySocketPath, leaseProvider);
    }
    const modelArguments = selectedProvider === undefined
      ? []
      : await aggregateModelArguments(socketPath, configuredBinary, passthrough);
    const invocation = resolveExecutableInvocation(configuredBinary, [
      "--remote",
      `unix://${socketPath}`,
      "-C",
      workdir,
      ...(selectedDefinition
        ? ["--profile", selectedDefinition.profileName]
        : []),
      ...modelArguments,
      ...permissionArguments,
      ...passthrough,
    ]);
    const result = spawnSync(invocation.file, invocation.args, {
      stdio: "inherit",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    assertSynchronousChildSuccess(result, {
      failureReportedByChild: true,
      failureMessage: (exitCode) => `Codex TUI 已退出：exit=${exitCode}`,
    });
  } finally {
    await providerLease?.close();
  }
}

function workspaceForWorkdir(workspaces, workdir) {
  let selected;
  for (const workspace of workspaces) {
    const childPath = relative(workspace.cwd, workdir);
    const containsWorkdir = childPath === ""
      || (childPath !== ".." && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath));
    if (containsWorkdir && (!selected || workspace.cwd.length > selected.cwd.length)) {
      selected = workspace;
    }
  }
  return selected;
}

function workspacePermissionArguments(workspace, passthrough, autoReviewSupported) {
  const overrides = explicitPermissionOverrides(passthrough);
  const permissions = stringValue(workspace?.permissions);
  const approvalPolicy = stringValue(workspace?.approval_policy);
  const approvalsReviewer = autoReviewSupported ? stringValue(workspace?.approvals_reviewer) : "user";
  if (!autoReviewSupported && overrides.autoReview) {
    throw new Error("codexc-aggregate 不支持 auto_review；请使用手动审批 user，移除 --approve-for-me 或 approvals_reviewer=auto_review");
  }
  if (!overrides.approval && approvalPolicy === "untrusted") {
    throw new Error(
      "Workspace 审批策略 untrusted 不能传给当前 Codex CLI；"
      + "请用 --ask-for-approval on-request|never 显式覆盖，或修改 Workspace 审批策略",
    );
  }
  return [
    ...(overrides.sandbox
      ? []
      : permissions
        ? ["-c", `default_permissions=${JSON.stringify(permissions)}`]
        : stringValue(workspace?.sandbox)
          ? ["--sandbox", stringValue(workspace.sandbox)]
          : []),
    ...(overrides.approval
      ? []
      : approvalPolicy
        ? ["--ask-for-approval", approvalPolicy]
        : []),
    ...(overrides.reviewer || !approvalsReviewer
      ? []
      : ["-c", `approvals_reviewer=${JSON.stringify(approvalsReviewer)}`]),
  ];
}

function explicitPermissionOverrides(args) {
  let sandbox = false;
  let approval = false;
  let reviewer = false;
  let autoReview = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;
    if (["--approve-for-me", "--not-so-yolo", "--dangerously-bypass-approvals-and-sandbox", "--yolo"].includes(argument)) {
      sandbox = true;
      approval = true;
      if (["--approve-for-me", "--not-so-yolo"].includes(argument)) {
        reviewer = true;
        autoReview = true;
      }
      continue;
    }
    if (argument === "--sandbox" || argument === "-s") {
      sandbox = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--sandbox=") || /^-s[^-]/u.test(argument)) {
      sandbox = true;
      continue;
    }
    if (argument === "--ask-for-approval" || argument === "-a") {
      approval = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--ask-for-approval=") || /^-a[^-]/u.test(argument)) {
      approval = true;
      continue;
    }
    const override = configOverrideArgument(args, index);
    if (!override) continue;
    index += override.consumed - 1;
    const { key, value } = override;
    if (key === "sandbox_mode" || key === "default_permissions") {
      sandbox = true;
    }
    if (key === "approval_policy") approval = true;
    if (key === "approvals_reviewer") {
      reviewer = true;
      autoReview ||= value === "auto_review";
    }
  }
  return { sandbox, approval, reviewer, autoReview };
}

function configOverrideArgument(args, index) {
  const argument = args[index];
  let raw;
  let consumed = 1;
  if (argument === "--config" || argument === "-c") {
    raw = args[index + 1];
    consumed = 2;
  } else if (argument.startsWith("--config=")) {
    raw = argument.slice("--config=".length);
  } else if (argument.startsWith("-c=")) {
    raw = argument.slice(3);
  } else if (/^-c[^-]/u.test(argument)) {
    raw = argument.slice(2);
  }
  if (raw === undefined) return undefined;
  const separator = raw.indexOf("=");
  if (separator < 0) return { key: raw.trim(), value: undefined, consumed };
  const key = raw.slice(0, separator).trim();
  const source = raw.slice(separator + 1).trim();
  let value;
  try {
    value = parse(`value = ${source}`).value;
  } catch {
    // Match the locked CLI's non-TOML fallback, including unmatched quotes.
    value = source.replace(/^["']+|["']+$/gu, "");
  }
  return { key, value, consumed };
}

function assertAggregateProviderArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") break;
    if (args[index] === "--oss" || args[index] === "--local-provider" || args[index].startsWith("--local-provider=")) {
      throw new Error("聚合 Remote 不能通过 Codex 参数切换 Provider；请从聚合目录选择模型");
    }
    const override = configOverrideArgument(args, index);
    if (!override) continue;
    index += override.consumed - 1;
    if (["model_provider", "model_providers", "model_catalog_json"].includes(override.key)
      || override.key.startsWith("model_providers.")) {
      throw new Error("聚合 Remote 不能覆盖 Provider 或模型目录；请从聚合目录选择模型");
    }
  }
}

async function aggregateModelArguments(socketPath, codexBinary, passthrough) {
  const { CodexAppServerClient, JsonRpcClient, createAppServerTransport } = await import("../dist/codex-client/index.js");
  const client = new CodexAppServerClient(new JsonRpcClient(
    createAppServerTransport({ kind: "local-app-server", socketPath }, { codexBinary, connectTimeoutMs: 3_000 }),
  ), { sandbox: "read-only" });
  try {
    await client.connect();
    const [{ model, effort }, models] = await Promise.all([
      client.readDefaultModelSettings(),
      client.listModels(),
    ]);
    const defaultModel = models.find((candidate) => model === null ? candidate.isDefault : candidate.model === model);
    if (!defaultModel) throw new Error("聚合 App Server 未返回目录中的默认模型；请重启 App Server 服务");
    const overrides = aggregateModelOverrides(passthrough);
    const selectedModel = overrides.model === undefined
      ? defaultModel
      : models.find((candidate) => candidate.model === overrides.model);
    if (!selectedModel) throw new Error("指定模型不在聚合目录中；请使用目录中的精确模型 ID");
    const selectedEffort = selectedModel.model === defaultModel.model
      ? effort ?? selectedModel.defaultReasoningEffort
      : selectedModel.defaultReasoningEffort;
    // Remote reads its catalog from the server, but local config wins for these
    // launch settings. Project the server defaults instead of inventing a Profile.
    return [
      "-c", `model=${JSON.stringify(selectedModel.model)}`,
      ...(overrides.effort ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(selectedEffort)}`]),
      "-c", "service_tier=\"default\"",
      "-c", "web_search=\"disabled\"",
    ];
  } finally {
    await client.close();
  }
}

function aggregateModelOverrides(args) {
  let cliModel;
  let configModel;
  let effort = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;
    const override = configOverrideArgument(args, index);
    if (override) {
      index += override.consumed - 1;
      if (override.key === "model") configModel = override.value;
      if (override.key === "model_reasoning_effort") effort = true;
      continue;
    }
    if (argument === "--model" || argument === "-m") {
      cliModel = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--model=")) {
      cliModel = argument.slice("--model=".length);
    } else if (argument.startsWith("-m=")) {
      cliModel = argument.slice(3);
    } else if (/^-m[^-]/u.test(argument)) {
      cliModel = argument.slice(2);
    }
  }
  // Config overrides are applied in order, then the CLI model wins regardless
  // of argument order (locked Codex Config::from_config: model.or(cfg.model)).
  return { model: cliModel ?? configModel, effort };
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
