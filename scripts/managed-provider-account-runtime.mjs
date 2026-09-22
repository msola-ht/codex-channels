import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { inspectAppServerSupervisorState, releaseAppServerProvider } from "../runtime/app-server-supervisor.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { runtimeConfig } from "./runtime-config.mjs";

export function managedAccountPrimarySocket(environment) {
  const { configPath, dataDir } = runtimeConfig(environment);
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
    const error = new Error("App Server 监管协议不兼容或响应无效；请先运行 codexc service restart app-server");
    error.code = "supervisor-incompatible";
    throw error;
  }
  return {
    provider,
    primarySocketPath,
    running: inspection.status === "ready" && inspection.topology.runningProviders.includes(provider),
  };
}

export async function releaseManagedAccountRuntime(plan, {
  releaseProvider = releaseAppServerProvider,
} = {}) {
  if (!plan.running) return "not-running";
  const release = await releaseProvider(plan.primarySocketPath, plan.provider);
  return release.reason === "released" ? "stopped"
    : release.reason === "leased" ? "in-use" : "not-running";
}

export async function stopManagedAccountForRemoval(provider, options = {}) {
  const plan = await inspectManagedAccountRuntime(provider, options);
  const action = await releaseManagedAccountRuntime(plan, options);
  if (action === "in-use") {
    const error = new Error(`账户 ${provider} 正在被 Remote TUI 使用；请退出对应 TUI 后再删除`);
    error.code = "account-runtime-in-use";
    throw error;
  }
  return action;
}
