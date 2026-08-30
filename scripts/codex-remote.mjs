import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  assertAppServerSocketPathSupported,
  resolvePrimaryAppServerSocketPath,
} from "../runtime/app-server-runtime.mjs";
import { acquireAppServerProviderLease } from "../runtime/app-server-supervisor.mjs";
import {
  loadConfiguredCustomSwitchingModelProviders,
  loadManagedModelProviders,
  providerAppServerSocketPath,
} from "../runtime/model-provider-runtime.mjs";
import {
  loadManagedModelProviderDefinitions,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import {
  executableInvocation,
  resolveExecutable,
} from "../runtime/executable.mjs";
import {
  assertSynchronousChildSuccess,
  ForwardedChildSignalError,
  ReportedChildExitError,
} from "../runtime/process-lifecycle.mjs";
import { parseCodexRemoteOptions } from "./codex-remote-options.mjs";
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
  const { passthrough, selectedProfile, workspaceId } = parseCodexRemoteOptions(
    process.argv.slice(2),
    {
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
  const permissionArguments = workspacePermissionArguments(workspace, passthrough);
  const primarySocketPath = resolvePrimaryAppServerSocketPath(document, runtime.dataDir);
  let socketPath = primarySocketPath;
  let providerLease;
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
    opencodeGoProviderDefinition,
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
    assertAppServerSocketPathSupported(socketPath);
    providerLease = await acquireAppServerProviderLease(
      primarySocketPath,
      managedProvider.provider,
    );
  }
  const configuredBinary = stringValue(codex.binary) || "codex";
  const codexBinary = resolveExecutable(configuredBinary);
  const invocation = executableInvocation(codexBinary, [
    "--remote",
    `unix://${socketPath}`,
    "-C",
    workdir,
    ...(selectedDefinition
      ? ["--profile", selectedDefinition.profileName]
      : []),
    ...permissionArguments,
    ...passthrough,
  ]);
  try {
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

function workspacePermissionArguments(workspace, passthrough) {
  const overrides = explicitPermissionOverrides(passthrough);
  const permissions = stringValue(workspace?.permissions);
  const approvalPolicy = stringValue(workspace?.approval_policy);
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
      : approvalPolicy === "untrusted"
        ? ["-c", `projects.${JSON.stringify(workspace.cwd)}.trust_level="untrusted"`]
        : approvalPolicy
          ? ["--ask-for-approval", approvalPolicy]
          : []),
  ];
}

function explicitPermissionOverrides(args) {
  let sandbox = false;
  let approval = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;
    if (["--approve-for-me", "--dangerously-bypass-approvals-and-sandbox"].includes(argument)) {
      sandbox = true;
      approval = true;
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
    let configOverride;
    if (argument === "--config" || argument === "-c") {
      configOverride = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--config=")) {
      configOverride = argument.slice("--config=".length);
    } else if (/^-c[^-]/u.test(argument)) {
      configOverride = argument.slice(2);
    }
    const key = stringValue(configOverride).split("=", 1)[0];
    if (key === "sandbox_mode" || key === "default_permissions") {
      sandbox = true;
    }
    if (key === "approval_policy") approval = true;
  }
  return { sandbox, approval };
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
