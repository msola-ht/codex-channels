import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { inspectAppServerSupervisorState, releaseAppServerProvider } from "../runtime/app-server-supervisor.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { locateUserConfig } from "./runtime-config.mjs";
import { AccountManagementError } from "./account-management-error.mjs";

export function managedAccountPrimarySocket(environment) {
  const { configPath, dataDir } = locateUserConfig(environment);
  return resolvePrimaryAppServerSocketPath(readGatewayConfig(configPath), dataDir);
}

export async function inspectManagedAccountRuntime(provider, {
  environment = process.env,
  resolvePrimarySocket = managedAccountPrimarySocket,
  inspectSupervisor = inspectAppServerSupervisorState,
} = {}) {
  const primarySocketPath = resolvePrimarySocket(environment);
  const inspection = await inspectSupervisor(primarySocketPath);
  if (inspection.status === "incompatible") {
    throw new AccountManagementError("supervisor-incompatible", "action", "App Server 监管协议不兼容或响应无效；请先运行 codexc restart appserver");
  }
  return {
    provider,
    primarySocketPath,
    registered: inspection.status === "ready" && (
      inspection.topology.primaryProvider === provider || inspection.topology.managedProviders.includes(provider)
    ),
    running: inspection.status === "ready" && inspection.topology.runningProviders.includes(provider),
  };
}

export async function releaseManagedAccountRuntime(plan, {
  releaseProvider = releaseAppServerProvider,
} = {}) {
  if (!plan.registered) return "not-running";
  const release = await releaseProvider(plan.primarySocketPath, plan.provider);
  return release.reason === "released" ? "stopped"
    : release.reason === "leased" ? "in-use" : "not-running";
}

export async function stopManagedAccountForRemoval(provider, options = {}) {
  const plan = await inspectManagedAccountRuntime(provider, options);
  const action = await releaseManagedAccountRuntime(plan, options);
  if (action === "in-use") {
    throw new AccountManagementError("account-runtime-in-use", "accountId", `账户 ${provider} 正在被 Remote TUI 使用；请退出对应 TUI 后再删除`);
  }
  return action;
}
