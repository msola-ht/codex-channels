import { spawn } from "node:child_process";

import { HttpsProxyAgent } from "https-proxy-agent";

import { resolveAppServerRuntime } from "./app-server-runtime.mjs";
import {
  AppServerSupervisorOwner,
  appServerSocketAcceptsWebSocket,
  prepareAppServerSocketPaths,
} from "./app-server-supervisor.mjs";
import { writeCliMessage as printCliMessage } from "./cli-presentation.mjs";
import { executableInvocation, resolveExecutable } from "./executable.mjs";
import { validateCodexConfigDocument } from "./gateway-config.mjs";
import {
  loadManagedModelProviderDefinitions,
  opencodeGoProviderDefinition,
} from "./model-provider-definitions.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
  loadOpenAiBaseUrl,
  loadThirdPartyModelProviderRole,
  loadThirdPartyProviderCredential,
  providerMetricsSocketPath,
  withOfficialModelCatalog,
  withOpenAiBaseUrl,
  withProviderBaseUrl,
  writeCustomOfficialModelCatalog,
  writeThirdPartyModelProviderRoleConfig,
} from "./model-provider-runtime.mjs";
import {
  loadOpencodeGoDefaultAccount,
  loadOpencodeGoAccounts,
  opencodeGoAccountIdFromProvider,
  opencodeGoProviderId,
  sharedProviderProxyKey,
} from "./opencode-go-accounts.mjs";
import { createOpencodeGoQuotaWindowsProvider } from "./opencode-go-quota-windows.mjs";
import { selectHttpProxyUrl } from "./network-proxy.mjs";
import {
  childProcessIsRunning,
  installProcessSignalHandlers,
  signalChildProcesses,
  terminateChildProcess,
} from "./process-lifecycle.mjs";
import { createProxyFetch } from "./proxy-fetch.mjs";

export async function runAppServerService(runtime, resolveDefaultWorkspace) {
  const validatedCodex = validateCodexConfigDocument(runtime.document.codex ?? {});
  if (Object.hasOwn(runtime.document, "ds_proxy")) {
    throw new Error("ds_proxy 已移除，模型统计代理现在由 App Server 服务自动管理");
  }
  runtime.environment.CODEX_CONNECT_SERVICE_ROLE = "app-server";
  applyAppServerTerminalIdentity(runtime.environment, validatedCodex.terminal_identity);
  const defaultWorkspace = resolveDefaultWorkspace();
  const appServerRuntime = resolveAppServerRuntime(
    runtime.document,
    runtime.dataDir,
    runtime.environment,
  );
  const customPrimaryProvider = loadConfiguredCustomPrimaryModelProvider(runtime.environment);
  const customSwitchingProviderIds = new Set(
    appServerRuntime.customSwitchingProviders.map((provider) => provider.provider),
  );
  const officialCatalogPath = customPrimaryProvider !== undefined
    || customSwitchingProviderIds.size > 0
    ? writeCustomOfficialModelCatalog(
        runtime.environment,
        runtime.environment.CODEX_BINARY,
      )
    : undefined;
  const customSwitchingProviders = officialCatalogPath === undefined
    ? appServerRuntime.customSwitchingProviders
    : appServerRuntime.customSwitchingProviders.map((provider) => ({
        ...provider,
        arguments: withOfficialModelCatalog(provider.arguments, officialCatalogPath),
      }));
  const managedProviders = officialCatalogPath === undefined
    ? appServerRuntime.managedProviders
    : appServerRuntime.managedProviders.map((provider) =>
        customSwitchingProviderIds.has(provider.provider)
          ? {
              ...provider,
              arguments: withOfficialModelCatalog(provider.arguments, officialCatalogPath),
            }
          : provider);
  const {
    primarySocketPath: socketPath,
    managedSocketPaths,
    primaryProvider,
  } = appServerRuntime;
  const customSwitchingProvidersById = new Map(
    customSwitchingProviders.map((provider) => [provider.provider, provider]),
  );
  const {
    ProviderProxy,
    sendProviderProxyMetrics,
  } = await import("../dist/provider-proxy/index.js");
  const providerProxies = [];
  const providerProxyRuntimes = new Map();
  const upstreamAgents = new Set();
  let supervisorOwner;
  const upstreamAgentFor = (upstreamUrl) => {
    const proxyUrl = selectHttpProxyUrl({
      http: runtime.environment.HTTP_PROXY,
      https: runtime.environment.HTTPS_PROXY,
      all: runtime.environment.ALL_PROXY,
      no: runtime.environment.NO_PROXY,
    }, upstreamUrl);
    if (!proxyUrl) return undefined;
    const agent = new HttpsProxyAgent(proxyUrl);
    upstreamAgents.add(agent);
    return agent;
  };
  const startProviderProxy = async (provider, options) => {
    const optionsWithUserAgent = {
      ...options,
      ...(validatedCodex.upstream_user_agent
        ? { upstreamUserAgent: validatedCodex.upstream_user_agent }
        : {}),
    };
    if (provider === "ocg") {
      const existing = providerProxyRuntimes.get("ocg");
      if (existing) return { ...existing, created: false };
      const modelProxy = new ProviderProxy("127.0.0.1:0", {
        ...optionsWithUserAgent,
        accountIds: goAccountIds.length === 0 ? undefined : goAccountIds,
        ...(goDefaultAccountId === undefined
          ? {}
          : { defaultAccountId: goDefaultAccountId }),
        quotaWindowsProvider: (accountId, signal) => {
          const quota = opencodeGoQuotaWindows.get(accountId ?? goDefaultAccountId);
          return quota ? quota(signal) : Promise.resolve(null);
        },
        onMetrics: (metrics, accountId) => {
          const targetAccountId = accountId ?? goDefaultAccountId;
          if (targetAccountId === undefined) return undefined;
          const targetProvider = opencodeGoProviderId(targetAccountId);
          return sendProviderProxyMetrics(
            providerMetricsSocketPath(socketPath, targetProvider),
            metrics,
          );
        },
        onError: (error) => console.error(
          "opencode-go 模型统计代理失败："
          + (error instanceof Error ? error.message : String(error)),
        ),
      });
      await modelProxy.start();
      providerProxies.push(modelProxy);
      const proxyRuntime = {
        baseUrl: `http://${modelProxy.address()}`,
        proxy: modelProxy,
      };
      providerProxyRuntimes.set("ocg", proxyRuntime);
      console.log(`opencode-go 模型统计代理已启动：${modelProxy.address()}`);
      return { ...proxyRuntime, created: true };
    }
    const existing = providerProxyRuntimes.get(provider);
    if (existing) return { ...existing, created: false };
    const modelProxy = new ProviderProxy("127.0.0.1:0", {
      ...optionsWithUserAgent,
      onMetrics: (metrics) => sendProviderProxyMetrics(
        providerMetricsSocketPath(socketPath, provider),
        metrics,
      ),
      onError: (error) => console.error(
        `${provider} 模型统计代理失败：${error instanceof Error ? error.message : String(error)}`,
      ),
    });
    await modelProxy.start();
    providerProxies.push(modelProxy);
    const proxyRuntime = {
      baseUrl: `http://${modelProxy.address()}`,
      proxy: modelProxy,
    };
    providerProxyRuntimes.set(provider, proxyRuntime);
    console.log(`${provider} 模型统计代理已启动：${modelProxy.address()}`);
    return { ...proxyRuntime, created: true };
  };
  const closeProviderProxy = async (proxy) => {
    for (const [provider, active] of providerProxyRuntimes) {
      if (active.proxy === proxy) providerProxyRuntimes.delete(provider);
    }
    const proxyIndex = providerProxies.indexOf(proxy);
    if (proxyIndex >= 0) providerProxies.splice(proxyIndex, 1);
    await proxy.close();
  };
  const providerDefinitions = new Map(
    loadManagedModelProviderDefinitions(runtime.environment)
      .map((definition) => [definition.id, definition]),
  );
  const thirdPartyRole = loadThirdPartyModelProviderRole(runtime.environment);
  const externalRoleBaseUrl = (baseUrl) =>
    `${baseUrl.replace(/\/+$/u, "")}/role/external`;
  const withExternalRoleMetrics = (provider, options) =>
    thirdPartyRole
      && sharedProviderProxyKey(thirdPartyRole.provider) === sharedProviderProxyKey(provider)
      ? {
          ...options,
          externalRoleReasoningEffort: thirdPartyRole.reasoningEffort,
        }
      : options;
  const goAccounts = loadOpencodeGoAccounts(runtime.environment);
  const goAccountIds = goAccounts.map((account) => account.id);
  const goDefaultAccount = thirdPartyRole
    && opencodeGoAccountIdFromProvider(thirdPartyRole.provider)
    ? goAccounts.find((account) =>
        account.id === opencodeGoAccountIdFromProvider(thirdPartyRole.provider))
    : loadOpencodeGoDefaultAccount(runtime.environment);
  const goDefaultAccountId = goDefaultAccount?.id;
  const opencodeGoQuotaWindows = new Map(goAccounts.map((account) => [
    account.id,
    createOpencodeGoQuotaWindowsProvider({
      environment: runtime.environment,
      fetchImpl: createProxyFetch({
        http: runtime.environment.HTTP_PROXY,
        https: runtime.environment.HTTPS_PROXY,
        all: runtime.environment.ALL_PROXY,
        no: runtime.environment.NO_PROXY,
      }),
      provider: opencodeGoProviderId(account.id),
    }),
  ]));
  const isGoProvider = (provider) =>
    opencodeGoAccountIdFromProvider(provider) !== undefined;
  const refreshThirdPartyRoleConfig = (provider, baseUrl) => {
    if (thirdPartyRole?.provider !== provider) return;
    try {
      writeThirdPartyModelProviderRoleConfig(runtime.environment, {
        provider,
        model: thirdPartyRole.model,
        baseUrl,
      });
    } catch (error) {
      throw new Error(
        `第三方子代理角色配置生成失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
  const proxyOptionsForUrl = (upstreamUrl) => {
    const upstreamAgent = upstreamAgentFor(upstreamUrl);
    return {
      ...(upstreamAgent ? { upstreamAgent } : {}),
      upstreamHost: upstreamUrl.hostname,
      ...(upstreamUrl.port ? { upstreamPort: Number(upstreamUrl.port) } : {}),
      upstreamProtocol: upstreamUrl.protocol === "http:" ? "http" : "https",
      upstreamBasePath: upstreamUrl.pathname,
    };
  };
  const goProxyOptions = proxyOptionsForUrl(new URL(opencodeGoProviderDefinition.baseUrl));
  let primaryArguments = [];
  const managedByProvider = new Map(managedProviders.map((provider, index) => [
    provider.provider,
    { runtime: provider, socketPath: managedSocketPaths[index] },
  ]));
  const instanceLaunches = new Map();
  const children = [];
  const childrenByProvider = new Map();
  let watchChild;
  let detachChild;
  const primaryChildCredential = thirdPartyRole
    ? loadThirdPartyProviderCredential(thirdPartyRole.provider, runtime.environment)
    : undefined;
  const primaryChildEnvironment = withoutManagedProviderApiKeys(runtime.environment);
  if (primaryChildCredential) {
    primaryChildEnvironment[primaryChildCredential.environmentKey] =
      primaryChildCredential.apiKey;
  }
  const ensureInstance = (provider, { waitForReady = true } = {}) => {
    const existing = instanceLaunches.get(provider);
    if (existing) return existing;
    const launch = (async () => {
      if (provider === primaryProvider) {
        const runningChild = childrenByProvider.get(provider);
        if (runningChild) {
          await waitForAppServer(socketPath, runningChild, provider);
          return;
        }
        if (await appServerSocketAcceptsWebSocket(socketPath)) return;
        await prepareAppServerSocketPaths([socketPath]);
        const child = spawnCodexProcess(runtime.environment.CODEX_BINARY, [
          ...primaryArguments,
          "app-server",
          "--listen",
          `unix://${socketPath}`,
        ], {
          stdio: "inherit",
          env: primaryChildEnvironment,
          cwd: defaultWorkspace.cwd,
        }, runtime.environment);
        children.push(child);
        childrenByProvider.set(provider, child);
        if (!waitForReady) {
          watchChild(child);
          return;
        }
        try {
          await waitForAppServer(socketPath, child, provider);
          watchChild(child);
          console.log(`${provider} App Server 已按需启动：${socketPath}`);
        } catch (error) {
          let cleanupError;
          childrenByProvider.delete(provider);
          if (childProcessIsRunning(child) && child.pid !== undefined) {
            try {
              await terminateChildProcess(child);
            } catch (terminationError) {
              cleanupError = terminationError;
            }
          }
          if (childProcessIsRunning(child)) {
            watchChild(child);
          } else {
            const childIndex = children.indexOf(child);
            if (childIndex >= 0) children.splice(childIndex, 1);
          }
          if (cleanupError) {
            throw new Error(
              `App Server 启动失败且资源未能完全清理：${provider}`,
              { cause: error },
            );
          }
          throw error;
        }
        return;
      }
      const managed = managedByProvider.get(provider);
      const definition = providerDefinitions.get(provider);
      const customDefinition = customSwitchingProvidersById.get(provider);
      if (!managed || (!definition && !customDefinition) || !managed.socketPath) {
        throw new Error(`模型 Provider 未配置独立 App Server：${provider}`);
      }
      if (await appServerSocketAcceptsWebSocket(managed.socketPath)) return;
      await prepareAppServerSocketPaths([managed.socketPath]);
      const proxyKey = sharedProviderProxyKey(provider);
      const { baseUrl: localBaseUrl, proxy, created: proxyCreated } = await startProviderProxy(
        proxyKey,
        withExternalRoleMetrics(provider, isGoProvider(provider)
          ? goProxyOptions
          : proxyOptionsForUrl(new URL(definition?.baseUrl ?? customDefinition.baseUrl))),
      );
      const providerBaseUrl = isGoProvider(provider)
        ? `${localBaseUrl}/go/${opencodeGoAccountIdFromProvider(provider)}`
        : localBaseUrl;
      let child;
      try {
        refreshThirdPartyRoleConfig(provider, externalRoleBaseUrl(localBaseUrl));
        const argumentsList = withProviderBaseUrl(
          managed.runtime.arguments,
          provider,
          providerBaseUrl,
        );
        child = spawnCodexProcess(runtime.environment.CODEX_BINARY, [
          ...argumentsList,
          "app-server",
          "--listen",
          `unix://${managed.socketPath}`,
        ], {
          stdio: "inherit",
          env: {
            ...withoutManagedProviderApiKeys(runtime.environment),
            ...managed.runtime.childEnvironment,
          },
          cwd: defaultWorkspace.cwd,
        }, runtime.environment);
        children.push(child);
        childrenByProvider.set(provider, child);
        await waitForAppServer(
          managed.socketPath,
          child,
          provider,
          "模型 Provider App Server",
        );
        watchChild(child);
        console.log(`${provider} App Server 已按需启动：${managed.socketPath}`);
      } catch (error) {
        let cleanupError;
        if (child) {
          childrenByProvider.delete(provider);
          if (childProcessIsRunning(child) && child.pid !== undefined) {
            try {
              await terminateChildProcess(child);
            } catch (terminationError) {
              cleanupError = terminationError;
            }
          }
          if (childProcessIsRunning(child)) {
            watchChild(child);
          } else {
            const childIndex = children.indexOf(child);
            if (childIndex >= 0) children.splice(childIndex, 1);
          }
        }
        if (proxyCreated) {
          try {
            await closeProviderProxy(proxy);
          } catch (proxyError) {
            cleanupError ??= proxyError;
          }
        }
        if (cleanupError) {
          throw new Error(
            `模型 Provider App Server 启动失败且资源未能完全清理：${provider}`,
            { cause: error },
          );
        }
        throw error;
      }
    })();
    instanceLaunches.set(provider, launch);
    launch.finally(() => instanceLaunches.delete(provider)).catch(() => undefined);
    return launch;
  };
  const releaseInstance = async (provider) => {
    if (instanceLaunches.get(provider)) {
      throw new Error(`App Server 正在启动，稍后重试：${provider}`);
    }
    if (provider !== primaryProvider && !managedByProvider.has(provider)) {
      throw new Error(`模型 Provider 未配置独立 App Server：${provider}`);
    }
    const child = childrenByProvider.get(provider);
    if (!child) return false;
    detachChild?.(child);
    try {
      await terminateChildProcess(child);
    } catch (error) {
      if (!children.includes(child)) children.push(child);
      watchChild?.(child);
      throw error;
    }
    childrenByProvider.delete(provider);
    if (provider !== primaryProvider && isGoProvider(provider)) {
      const remainingGoChild = [...childrenByProvider.keys()].some(isGoProvider);
      const roleUsesGoProxy = thirdPartyRole && isGoProvider(thirdPartyRole.provider);
      if (!remainingGoChild && !roleUsesGoProxy) {
        const goProxy = providerProxyRuntimes.get("ocg")?.proxy;
        if (goProxy) await closeProviderProxy(goProxy);
      }
    }
    console.log(`${provider} App Server 已释放：${
      provider === primaryProvider
        ? socketPath
        : managedByProvider.get(provider).socketPath
    }`);
    return true;
  };
  try {
    await prepareAppServerSocketPaths(appServerRuntime.socketPaths);
    if (customPrimaryProvider) {
      const { baseUrl: localBaseUrl } = await startProviderProxy(
        primaryProvider,
        withExternalRoleMetrics(
          customPrimaryProvider.id,
          proxyOptionsForUrl(new URL(customPrimaryProvider.baseUrl)),
        ),
      );
      primaryArguments = withProviderBaseUrl(
        ["-c", `model_provider=${JSON.stringify(customPrimaryProvider.id)}`],
        customPrimaryProvider.id,
        localBaseUrl,
      );
      primaryArguments = withOfficialModelCatalog(primaryArguments, officialCatalogPath);
      refreshThirdPartyRoleConfig(
        customPrimaryProvider.id,
        externalRoleBaseUrl(localBaseUrl),
      );
    } else if (primaryProvider === "openai") {
      const configuredOpenAiBaseUrl = loadOpenAiBaseUrl(runtime.environment);
      let openAiProxyOptions;
      if (configuredOpenAiBaseUrl) {
        openAiProxyOptions = proxyOptionsForUrl(new URL(configuredOpenAiBaseUrl));
      } else {
        const chatgptUrl = new URL("https://chatgpt.com/backend-api/codex");
        const apiUrl = new URL("https://api.openai.com/v1");
        const chatgptAgent = upstreamAgentFor(chatgptUrl);
        const apiAgent = upstreamAgentFor(apiUrl);
        openAiProxyOptions = {
          upstreamHost: apiUrl.hostname,
          upstreamProtocol: "https",
          upstreamBasePath: apiUrl.pathname,
          resolveUpstream: (headers) => {
            const target = headers["chatgpt-account-id"] === undefined ? apiUrl : chatgptUrl;
            const agent = target === chatgptUrl ? chatgptAgent : apiAgent;
            return {
              ...(agent ? { agent } : {}),
              host: target.hostname,
              protocol: "https",
              basePath: target.pathname,
            };
          },
        };
      }
      const { baseUrl: localBaseUrl } = await startProviderProxy("openai", {
        ...openAiProxyOptions,
        allowOpenAiApiPaths: true,
      });
      primaryArguments = withOpenAiBaseUrl(primaryArguments, localBaseUrl);
    } else {
      const definition = providerDefinitions.get(primaryProvider);
      if (!definition) throw new Error(`未知主模型 Provider：${primaryProvider}`);
      const providerKey = isGoProvider(definition.id) ? "ocg" : definition.id;
      const { baseUrl: localBaseUrl } = await startProviderProxy(
        providerKey,
        withExternalRoleMetrics(definition.id, isGoProvider(definition.id)
          ? goProxyOptions
          : proxyOptionsForUrl(new URL(definition.baseUrl))),
      );
      const primaryBaseUrl = isGoProvider(definition.id)
        ? `${localBaseUrl}/go/${opencodeGoAccountIdFromProvider(definition.id)}`
        : localBaseUrl;
      primaryArguments = withProviderBaseUrl(
        primaryArguments,
        definition.id,
        primaryBaseUrl,
      );
      refreshThirdPartyRoleConfig(
        definition.id,
        externalRoleBaseUrl(localBaseUrl),
      );
    }
    if (thirdPartyRole && managedByProvider.has(thirdPartyRole.provider)) {
      const provider = thirdPartyRole.provider;
      const definition = providerDefinitions.get(provider);
      const customDefinition = customSwitchingProvidersById.get(provider);
      if (!definition && !customDefinition) throw new Error(`未知第三方 Provider：${provider}`);
      const providerKey = isGoProvider(provider) ? "ocg" : provider;
      const { baseUrl: localBaseUrl } = await startProviderProxy(
        providerKey,
        withExternalRoleMetrics(provider, isGoProvider(provider)
          ? goProxyOptions
          : proxyOptionsForUrl(new URL(definition?.baseUrl ?? customDefinition.baseUrl))),
      );
      refreshThirdPartyRoleConfig(provider, externalRoleBaseUrl(localBaseUrl));
    }
    const lifecycle = forwardChildrenLifecycle(children, async () => {
      await supervisorOwner?.close();
      await Promise.all(providerProxies.map((proxy) => proxy.close()));
      for (const agent of upstreamAgents) agent.destroy();
    });
    watchChild = lifecycle.watchChild;
    detachChild = lifecycle.detachChild;
    supervisorOwner = new AppServerSupervisorOwner(
      socketPath,
      appServerRuntime.topology,
      { ensureProvider: ensureInstance, releaseProvider: releaseInstance },
    );
    await supervisorOwner.start();
    await ensureInstance(primaryProvider, { waitForReady: false });
    supervisorOwner.markRunning(primaryProvider);
  } catch (error) {
    await supervisorOwner?.close();
    await Promise.all(providerProxies.map((proxy) => proxy.close()));
    for (const agent of upstreamAgents) agent.destroy();
    throw error;
  }
}

function applyAppServerTerminalIdentity(environment, terminalIdentity) {
  if (terminalIdentity === undefined) return;
  const separator = terminalIdentity.indexOf("/");
  if (separator < 0) {
    environment.TERM_PROGRAM = terminalIdentity;
    delete environment.TERM_PROGRAM_VERSION;
    return;
  }
  environment.TERM_PROGRAM = terminalIdentity.slice(0, separator);
  environment.TERM_PROGRAM_VERSION = terminalIdentity.slice(separator + 1);
}

function withoutManagedProviderApiKeys(environment) {
  const childEnvironment = { ...environment };
  const managedKeys = new Set(
    loadManagedModelProviderDefinitions(environment)
      .map(({ apiKeyEnvironmentKey }) => apiKeyEnvironmentKey),
  );
  // 旧版单账户环境变量在迁移后不再属于动态定义，仍必须从子进程环境剥离。
  managedKeys.add("CODEX_CONNECT_OPENCODE_GO_API_KEY");
  for (const key of managedKeys) {
    delete childEnvironment[key];
  }
  for (const key of Object.keys(childEnvironment)) {
    if (
      /^CODEX_CONNECT_OPENCODE_GO(?:_[A-Z0-9_]+)?_API_KEY$/u.test(key)
      || /^CODEX_CONNECT_CUSTOM_[A-F0-9]+_API_KEY$/u.test(key)
    ) {
      delete childEnvironment[key];
    }
  }
  return childEnvironment;
}

function spawnCodexProcess(codexBinary, args, options, environment) {
  const invocation = executableInvocation(
    resolveExecutable(codexBinary, environment),
    args,
    environment,
  );
  return spawn(invocation.file, invocation.args, {
    ...options,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

function waitForAppServer(
  socketPath,
  child,
  provider,
  label = "App Server",
  timeoutMs = 10_000,
) {
  return new Promise((resolveWait, rejectWait) => {
    const startedAt = Date.now();
    let timer;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveWait();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectWait(error);
    };
    const onError = (error) => fail(new Error(
      `${label} 启动失败：${provider}（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    ));
    const onExit = (code, signal) => fail(new Error(
      `${label} 启动失败：${provider}（${signal ? `signal=${signal}` : `exit=${code ?? 1}`}）；请查看 App Server 服务日志`,
    ));
    const check = async () => {
      try {
        if (await appServerSocketAcceptsWebSocket(socketPath)) {
          succeed();
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          fail(new Error(`等待 ${label} 就绪超时：${provider}`));
          return;
        }
        timer = setTimeout(() => void check(), 100);
      } catch (error) {
        fail(error);
      }
    };
    child.once("error", onError);
    child.once("exit", onExit);
    void check();
  });
}

function forwardChildrenLifecycle(children, closeResources = async () => undefined) {
  let settled = false;
  const watchers = new Map();
  const forward = (signal) => signalChildProcesses(children, signal);
  let cleanup = () => undefined;
  const finish = (code, signal, error, initialSignal = "SIGTERM") => {
    if (settled) return;
    settled = true;
    cleanup();
    if (initialSignal) forward(initialSignal);
    void (async () => {
      const cleanupResults = await Promise.allSettled([
        Promise.resolve().then(closeResources),
      ]);
      const terminationResults = await Promise.allSettled(
        [...children].map((child) => terminateChildProcess(child)),
      );
      const cleanupFailure = [...cleanupResults, ...terminationResults]
        .find((result) => result.status === "rejected");
      if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
      if (error) {
        printCliMessage(
          "failure",
          `Codex App Server 进程启动失败：${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        return;
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        printCliMessage("failure", `Codex App Server 进程意外退出：exit=${exitCode}`);
      }
      process.exitCode = exitCode;
    })().catch((closeError) => {
      printCliMessage(
        "failure",
        `Codex App Server 资源清理失败：${closeError instanceof Error ? closeError.message : String(closeError)}`,
      );
      process.exitCode = 1;
    });
  };
  const cleanupSignals = installProcessSignalHandlers({
    SIGTERM: () => finish(null, "SIGTERM", undefined, "SIGTERM"),
    SIGINT: () => finish(null, "SIGINT", undefined, "SIGINT"),
  });
  const onControlMessage = (message) => {
    if (message?.type === "codexc-stop") finish(0, null, undefined, null);
  };
  process.on("message", onControlMessage);
  cleanup = () => {
    cleanupSignals();
    process.off("message", onControlMessage);
  };
  const watchChild = (child) => {
    if (watchers.has(child)) return;
    const onError = (error) => finish(1, null, error);
    const onExit = (code, signal) => finish(code, signal);
    watchers.set(child, { onError, onExit });
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(child.exitCode, child.signalCode);
      return;
    }
    child.once("error", onError);
    child.once("exit", onExit);
  };
  const detachChild = (child) => {
    const watcher = watchers.get(child);
    if (!watcher) return;
    watchers.delete(child);
    child.off("error", watcher.onError);
    child.off("exit", watcher.onExit);
    const index = children.indexOf(child);
    if (index >= 0) children.splice(index, 1);
  };
  for (const child of children) watchChild(child);
  return { watchChild, detachChild };
}
