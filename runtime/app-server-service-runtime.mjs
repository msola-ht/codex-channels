import { isResponsesProvider, responsesProviderCatalogPath } from "./model-provider-responses-catalog.mjs";
import { readCodexProxySettings } from "./codex-proxy-env.mjs";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { HttpsProxyAgent } from "https-proxy-agent";

import { resolveAppServerRuntime } from "./app-server-runtime.mjs";
import { startDesktopAppBridge } from "./desktop-app-bridge.mjs";
import {
  macDesktopAppPluginEnabledConfigKey,
  spawnMacDesktopHostedCodex,
  validateMacDesktopAppAttachment,
} from "./desktop-app-host.mjs";
import {
  AppServerSupervisorOwner,
  appServerSocketAcceptsWebSocket,
  prepareAppServerSocketPaths,
} from "./app-server-supervisor.mjs";
import { writeCliMessage as printCliMessage } from "./cli-presentation.mjs";
import { executableInvocation, resolveExecutable } from "./executable.mjs";
import {
  validateCodexConfigDocument,
  validateDebugConfigDocument,
} from "./gateway-config.mjs";
import {
  loadManagedModelProviderDefinitions,
  opencodeGoProviderDefinition,
} from "./model-provider-definitions.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
  loadOpenAiBaseUrl,
  providerMetricsSocketPath,
  withOfficialModelCatalog,
  withOpenAiBaseUrl,
  withProviderBaseUrl,
  writeCustomOfficialModelCatalog,
} from "./model-provider-runtime.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountIdFromProvider,
  opencodeGoProviderId,
} from "./opencode-go-accounts.mjs";
import {
  managedProviderAccountIdFromProvider,
  sharedProviderProxyKey,
} from "./managed-provider-account-routing.mjs";
import { loadDeepseekAccounts, deepseekProviderId } from "./deepseek-accounts.mjs";
import { loadCcgAccounts, ccgProviderId } from "./ccg-accounts.mjs";
import { createOpencodeGoQuotaWindowsProvider } from "./opencode-go-quota-windows.mjs";
import { createRefreshableHttpProxySelector } from "./network-proxy.mjs";
import {
  childProcessIsRunning,
  installProcessSignalHandlers,
  signalChildProcesses,
  terminateChildProcess,
} from "./process-lifecycle.mjs";
import { createProxyFetch } from "./proxy-fetch.mjs";
import { ProviderProxyRuntimeRegistry } from "./provider-proxy-runtime-registry.mjs";

export async function runAppServerService(runtime, resolveDefaultWorkspace) {
  const validatedCodex = validateCodexConfigDocument(runtime.document.codex ?? {});
  const validatedDebug = validateDebugConfigDocument(runtime.document.debug ?? {});
  const trafficDumpDirectory = join(runtime.dataDir, "traffic");
  if (Object.hasOwn(runtime.document, "ds_proxy")) {
    throw new Error("ds_proxy 已移除，模型统计代理现在由 App Server 服务自动管理");
  }
  if (
    validatedCodex.desktop_app?.enabled === true
    && process.platform !== "darwin"
    && process.platform !== "win32"
  ) {
    throw new Error("Codex Desktop App 共享当前只支持 macOS 与 Windows");
  }
  runtime.environment.CODEX_CONNECT_SERVICE_ROLE = "app-server";
  applyAppServerTerminalIdentity(runtime.environment, validatedCodex.terminal_identity);
  applyAppServerTimezone(runtime.environment, validatedCodex.timezone);
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
  const officialCatalogPath = (customPrimaryProvider !== undefined && customPrimaryProvider.catalogPath === undefined)
    || [...customSwitchingProviderIds].some(id => !isResponsesProvider(id))
    ? writeCustomOfficialModelCatalog(
        runtime.environment,
        runtime.environment.CODEX_BINARY,
      )
    : undefined;
  const customSwitchingProviders = officialCatalogPath === undefined
    ? appServerRuntime.customSwitchingProviders
    : appServerRuntime.customSwitchingProviders.map((provider) => ({
        ...provider,
        arguments: withOfficialModelCatalog(provider.arguments, isResponsesProvider(provider.provider) ? responsesProviderCatalogPath(runtime.environment, provider.provider) : officialCatalogPath),
      }));
  const managedProviders = officialCatalogPath === undefined
    ? appServerRuntime.managedProviders
    : appServerRuntime.managedProviders.map((provider) =>
        customSwitchingProviderIds.has(provider.provider)
          ? {
              ...provider,
              arguments: withOfficialModelCatalog(provider.arguments, isResponsesProvider(provider.provider) ? responsesProviderCatalogPath(runtime.environment, provider.provider) : officialCatalogPath),
            }
          : provider);
  const {
    primarySocketPath: socketPath,
    managedSocketPaths,
    primaryProvider,
  } = appServerRuntime;
  if (validatedCodex.desktop_app?.enabled === true && primaryProvider !== "openai") {
    throw new Error("Codex Desktop App 共享只支持 OpenAI 主 Provider");
  }
  const customSwitchingProvidersById = new Map(
    customSwitchingProviders.map((provider) => [provider.provider, provider]),
  );
  const {
    ProviderProxy,
    ChatCompletionsBridge,
    pruneModelTrafficDumpSessions,
    sendProviderProxyMetrics,
  } = await import("../dist/provider-proxy/index.js");
  const upstreamAgents = new Set();
  const upstreamAgentsByProxyUrl = new Map();
  const proxySelector = createRefreshableHttpProxySelector(
    readCodexProxySettings(runtime.environment),
    process.env,
  );
  let supervisorOwner;
  let desktopAppBridge;
  const upstreamAgentFor = async (upstreamUrl) => {
    const proxyUrl = await proxySelector.select(upstreamUrl);
    if (!proxyUrl) return undefined;
    const existing = upstreamAgentsByProxyUrl.get(proxyUrl);
    if (existing) return existing;
    const agent = new HttpsProxyAgent(proxyUrl);
    upstreamAgents.add(agent);
    upstreamAgentsByProxyUrl.set(proxyUrl, agent);
    return agent;
  };
  const providerProxyRuntimes = new ProviderProxyRuntimeRegistry(async (
    provider,
    options,
  ) => {
    const definition = providerDefinitions.get(provider);
    let bridge;
    if (definition?.upstreamWireApi === "chat_completions") {
      bridge = new ChatCompletionsBridge({ ...options,
        onError: () => proxySelector.invalidate(),
        ...(validatedCodex.upstream_user_agent ? { upstreamUserAgent: validatedCodex.upstream_user_agent } : {}),
      });
      await bridge.start();
      const url = new URL(`http://${bridge.address()}`);
      options = { upstreamHost: url.hostname, upstreamPort: Number(url.port), upstreamProtocol: "http", chatDiagnostics: bridge.diagnostics };
    }
    const optionsWithUserAgent = {
      ...options,
      ...(validatedCodex.upstream_user_agent
        ? { upstreamUserAgent: validatedCodex.upstream_user_agent }
        : {}),
      ...(!validatedDebug.model_traffic_dump
        ? {}
        : {
            trafficDump: {
              directory: trafficDumpDirectory,
              inputItems: validatedDebug.model_traffic_input_items,
              itemMaxBytes: validatedDebug.model_traffic_item_max_bytes,
              retentionDays: validatedDebug.model_traffic_retention_days,
              label: provider,
            },
          }),
    };
    const opencodeGo = provider === "ocg";
    const managedAccountProxyOptions = (accounts, providerId, label) => ({
      accountIds: accounts.map((account) => account.id),
      defaultAccountId: accounts.find((account) => account.default)?.id,
      onMetrics: (metrics, accountId) => {
        if (accountId === undefined) throw new Error(`${label} 统计缺少账户 ID`);
        return sendProviderProxyMetrics(
          providerMetricsSocketPath(socketPath, providerId(accountId)),
          metrics,
        );
      },
    });
    const modelProxy = new ProviderProxy("127.0.0.1:0", {
      ...optionsWithUserAgent,
      ...(opencodeGo
        ? {
            accountIds: goAccountIds.length === 0 ? undefined : goAccountIds,
            ...(goDefaultAccountId === undefined
              ? {}
              : { defaultAccountId: goDefaultAccountId }),
            quotaWindowsProvider: (accountId, signal) => {
              const quota = opencodeGoQuotaWindows.get(
                accountId ?? goDefaultAccountId,
              );
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
          }
        : provider === "deepseek"
          ? managedAccountProxyOptions(dsAccounts, deepseekProviderId, "DS")
          : provider === "ccg"
            ? managedAccountProxyOptions(ccgAccounts, ccgProviderId, "CCG")
            : {
                onMetrics: (metrics) => sendProviderProxyMetrics(
                  providerMetricsSocketPath(socketPath, provider),
                  metrics,
                ),
              }),
      onError: (error) => {
        proxySelector.invalidate();
        console.error(
          `${opencodeGo ? "opencode-go" : provider} 模型统计代理失败：`
          + (error instanceof Error ? error.message : String(error)),
        );
      },
    });
    try { await modelProxy.start(); } catch (error) { await bridge?.close(); throw error; }
    const proxyRuntime = {
      baseUrl: `http://${modelProxy.address()}`,
      proxy: bridge ? { close: async () => {
        try { await modelProxy.close(); } finally { await bridge.close(); }
      } } : modelProxy,
    };
    console.log(
      `${opencodeGo ? "opencode-go" : provider} 模型统计代理已启动：${modelProxy.address()}`,
    );
    return proxyRuntime;
  });
  const startProviderProxy = (provider, options) =>
    providerProxyRuntimes.ensure(provider, options);
  const closeProviderProxy = async (proxy) => {
    providerProxyRuntimes.remove(proxy);
    await proxy.close();
  };
  const providerDefinitions = new Map(
    loadManagedModelProviderDefinitions(runtime.environment)
      .map((definition) => [definition.id, definition]),
  );
  const goAccounts = loadOpencodeGoAccounts(runtime.environment);
  const dsAccounts = loadDeepseekAccounts(runtime.environment);
  const ccgAccounts = loadCcgAccounts(runtime.environment);
  const proxyAccountId = managedProviderAccountIdFromProvider;
  const goAccountIds = goAccounts.map((account) => account.id);
  const goDefaultAccount = goAccounts.find((account) => account.default);
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
  const proxyOptionsForUrl = async (upstreamUrl) => {
    await proxySelector.validate(upstreamUrl);
    return {
      upstreamHost: upstreamUrl.hostname,
      ...(upstreamUrl.port ? { upstreamPort: Number(upstreamUrl.port) } : {}),
      upstreamProtocol: upstreamUrl.protocol === "http:" ? "http" : "https",
      upstreamBasePath: upstreamUrl.pathname,
      resolveUpstream: async () => {
        const agent = await upstreamAgentFor(upstreamUrl);
        return {
          ...(agent ? { agent } : {}),
          host: upstreamUrl.hostname,
          ...(upstreamUrl.port ? { port: Number(upstreamUrl.port) } : {}),
          protocol: upstreamUrl.protocol === "http:" ? "http" : "https",
          basePath: upstreamUrl.pathname,
        };
      },
    };
  };
  const goProxyOptions = () =>
    proxyOptionsForUrl(new URL(opencodeGoProviderDefinition.baseUrl));
  let primaryArguments = [];
  let desktopAppAttachment;
  const managedByProvider = new Map(managedProviders.map((provider, index) => [
    provider.provider,
    { runtime: provider, socketPath: managedSocketPaths[index] },
  ]));
  const instanceLaunches = new Map();
  const children = [];
  const childrenByProvider = new Map();
  const providerProxyIsInUse = (proxyKey) =>
    providerProxyRuntimes.hasUsers(proxyKey)
    || sharedProviderProxyKey(primaryProvider) === proxyKey;
  let watchChild;
  let detachChild;
  const primaryChildEnvironment = withoutManagedProviderApiKeys(runtime.environment);
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
        const primaryAppServerArguments = [
          ...primaryArguments,
          ...(desktopAppAttachment
            ? [
                "-c",
                `${macDesktopAppPluginEnabledConfigKey}=${desktopAppAttachment.toolsEnabled}`,
              ]
            : []),
          "app-server",
          "--listen",
          `unix://${socketPath}`,
        ];
        const primarySpawnOptions = {
          stdio: "inherit",
          env: primaryChildEnvironment,
          cwd: defaultWorkspace.cwd,
        };
        const child = desktopAppAttachment
          ? spawnMacDesktopHostedCodex(
              desktopAppAttachment,
              primaryAppServerArguments,
              primarySpawnOptions,
            )
          : spawnCodexProcess(
              runtime.environment.CODEX_BINARY,
              primaryAppServerArguments,
              primarySpawnOptions,
              runtime.environment,
            );
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
      providerProxyRuntimes.addUser(proxyKey, provider);
      let proxy;
      let child;
      try {
        const startedProxy = await startProviderProxy(
          proxyKey,
          isGoProvider(provider)
            ? await goProxyOptions()
            : await proxyOptionsForUrl(new URL(
                definition?.baseUrl ?? customDefinition.baseUrl,
              )),
        );
        proxy = startedProxy.proxy;
        const providerBaseUrl = proxyAccountId(provider) !== undefined
          ? `${startedProxy.baseUrl}/go/${proxyAccountId(provider)}`
          : startedProxy.baseUrl;
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
        providerProxyRuntimes.removeUser(proxyKey, provider);
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
        if (proxy && !providerProxyIsInUse(proxyKey)) {
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
    if (provider !== primaryProvider) {
      const proxyKey = sharedProviderProxyKey(provider);
      providerProxyRuntimes.removeUser(proxyKey, provider);
      if (isGoProvider(provider) && !providerProxyIsInUse(proxyKey)) {
        const proxy = providerProxyRuntimes.get(proxyKey)?.proxy;
        if (proxy) await closeProviderProxy(proxy);
      }
    }
    console.log(`${provider} App Server 已释放：${
      provider === primaryProvider
        ? socketPath
        : managedByProvider.get(provider).socketPath
    }`);
    return true;
  };
  const attachDesktopApp = async ({ appPath, pipePath, toolsEnabled }) => {
    if (
      process.platform !== "darwin"
      || validatedCodex.desktop_app?.enabled !== true
      || primaryProvider !== "openai"
    ) {
      throw new Error("macOS Codex Desktop App 共享未启用");
    }
    const nextAttachment = validateMacDesktopAppAttachment({
      appPath,
      pipePath,
      toolsEnabled,
      codexBinary: runtime.environment.CODEX_BINARY,
      environment: runtime.environment,
    });
    if (desktopAppAttachment?.key === nextAttachment.key) {
      await ensureInstance(primaryProvider);
      return;
    }
    await instanceLaunches.get(primaryProvider);
    const previousAttachment = desktopAppAttachment;
    const released = await releaseInstance(primaryProvider);
    if (!released) {
      throw new Error("主 OpenAI App Server 不受当前服务监管");
    }
    desktopAppAttachment = nextAttachment;
    try {
      await ensureInstance(primaryProvider);
    } catch (error) {
      desktopAppAttachment = previousAttachment;
      let recoveryError;
      try {
        await releaseInstance(primaryProvider);
        await ensureInstance(primaryProvider);
      } catch (recoveryFailure) {
        recoveryError = recoveryFailure;
      }
      if (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "Desktop Host 附加失败，且主 App Server 未能恢复",
          { cause: error },
        );
      }
      throw error;
    }
    console.log("Codex Desktop App 可信 Host 已附加");
  };
  const detachDesktopApp = async () => {
    if (desktopAppAttachment === undefined) return;
    desktopAppAttachment = undefined;
    console.log("Codex Desktop App 可信 Host 租约已释放");
  };
  try {
    await prepareAppServerSocketPaths(appServerRuntime.socketPaths);
    if (customPrimaryProvider) {
      const { baseUrl: localBaseUrl } = await startProviderProxy(
        primaryProvider,
        await proxyOptionsForUrl(new URL(customPrimaryProvider.baseUrl)),
      );
      primaryArguments = withProviderBaseUrl(
        ["-c", `model_provider=${JSON.stringify(customPrimaryProvider.id)}`],
        customPrimaryProvider.id,
        localBaseUrl,
      );
      primaryArguments = withOfficialModelCatalog(primaryArguments, customPrimaryProvider.catalogPath ?? officialCatalogPath);
      if (customPrimaryProvider.catalogPath) primaryArguments.push("-c", 'web_search="disabled"');
    } else if (primaryProvider === "openai") {
      const configuredOpenAiBaseUrl = loadOpenAiBaseUrl(runtime.environment);
      const configuredOpenAiUrl = configuredOpenAiBaseUrl
        ? new URL(configuredOpenAiBaseUrl)
        : undefined;
      let openAiProxyOptions;
      if (configuredOpenAiUrl) {
        openAiProxyOptions = await proxyOptionsForUrl(configuredOpenAiUrl);
      } else {
        const chatgptUrl = new URL("https://chatgpt.com/backend-api/codex");
        const apiUrl = new URL("https://api.openai.com/v1");
        await proxySelector.validate(chatgptUrl);
        await proxySelector.validate(apiUrl);
        openAiProxyOptions = {
          upstreamHost: apiUrl.hostname,
          upstreamProtocol: "https",
          upstreamBasePath: apiUrl.pathname,
          resolveUpstream: async (headers) => {
            const target = headers["chatgpt-account-id"] === undefined ? apiUrl : chatgptUrl;
            const agent = await upstreamAgentFor(target);
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
      if (definition.upstreamWireApi === "chat_completions") primaryArguments.push("-c", 'web_search="disabled"');
      const providerKey = sharedProviderProxyKey(definition.id);
      const { baseUrl: localBaseUrl } = await startProviderProxy(
        providerKey,
        isGoProvider(definition.id)
          ? await goProxyOptions()
          : await proxyOptionsForUrl(new URL(definition.baseUrl)),
      );
      const primaryBaseUrl = proxyAccountId(definition.id) !== undefined
        ? `${localBaseUrl}/go/${proxyAccountId(definition.id)}`
        : localBaseUrl;
      primaryArguments = withProviderBaseUrl(
        primaryArguments,
        definition.id,
        primaryBaseUrl,
      );
    }
    const lifecycle = forwardChildrenLifecycle(children, async () => {
      await proxySelector.close();
      await desktopAppBridge?.close();
      await supervisorOwner?.close();
      await Promise.all(
        providerProxyRuntimes.values().map(({ proxy }) => proxy.close()),
      );
      for (const agent of upstreamAgents) agent.destroy();
    });
    watchChild = lifecycle.watchChild;
    detachChild = lifecycle.detachChild;
    supervisorOwner = new AppServerSupervisorOwner(
      socketPath,
      appServerRuntime.topology,
      {
        ensureProvider: ensureInstance,
        releaseProvider: releaseInstance,
        attachDesktopApp,
        detachDesktopApp,
      },
    );
    await supervisorOwner.start();
    try {
      pruneModelTrafficDumpSessions({
        directory: trafficDumpDirectory,
        retentionDays: validatedDebug.model_traffic_retention_days,
      });
    } catch (error) {
      console.error(
        "模型请求转储自动清理失败："
        + (error instanceof Error ? error.message : String(error)),
      );
    }
    await ensureInstance(primaryProvider, { waitForReady: false });
    supervisorOwner.markRunning(primaryProvider);
    if (validatedCodex.desktop_app?.enabled === true && process.platform === "win32") {
      await ensureInstance(primaryProvider);
      desktopAppBridge = await startDesktopAppBridge({
        port: validatedCodex.desktop_app.port,
        socketPath,
        primaryProvider,
        codexBinary: runtime.environment.CODEX_BINARY,
        dataDir: runtime.dataDir,
        onEvent: (event) => {
          if (event.type === "connection-error") {
            console.error(`Codex Desktop App 桥连接失败：${event.stage}`);
          }
        },
      });
      console.log(
        `Codex Desktop App 桥已启动：127.0.0.1:${validatedCodex.desktop_app.port}`,
      );
    }
  } catch (error) {
    await proxySelector.close();
    await desktopAppBridge?.close();
    await supervisorOwner?.close();
    await Promise.all(
      providerProxyRuntimes.values().map(({ proxy }) => proxy.close()),
    );
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

/**
 * 只给 App Server 子进程设置时区：`[codex].timezone` 未配置时保持继承环境，不覆盖系统时区。
 * 模型请求的 environment context 由 App Server 读进程时区生成，因此该值随 App Server 重启生效。
 */
export function applyAppServerTimezone(environment, timezone) {
  if (timezone === undefined) return;
  environment.TZ = timezone;
}

function withoutManagedProviderApiKeys(environment) {
  const childEnvironment = { ...environment };
  const managedKeys = new Set(
    loadManagedModelProviderDefinitions(environment)
      .map(({ apiKeyEnvironmentKey }) => apiKeyEnvironmentKey),
  );
  // 旧版单账户环境变量不属于当前动态定义，仍必须从子进程环境剥离。
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
