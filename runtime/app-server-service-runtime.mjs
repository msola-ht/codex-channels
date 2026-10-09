import { loadClinePassAccounts, clinePassProviderId } from "./cline-pass-accounts.mjs";
import { isResponsesProvider, responsesProviderCatalogPath, parseResponsesModelCatalog, responsesContextSyncPath } from "./model-provider-responses-catalog.mjs";
import { readCodexProxySettings } from "./codex-proxy-env.mjs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { aggregateProviderId, aggregateTokenEnvironmentKey, aggregateLaunchArguments, loadAggregateModelMaterial,
  readAggregateProviderSettingsFingerprint } from "./aggregate-model-provider.mjs";
import { AggregateMaterialGuard } from "./aggregate-material-guard.mjs";
import { ProviderModelGuard } from "./provider-model-guard.mjs";

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
  readAppServerProviderSettingsFingerprint,
} from "./app-server-supervisor.mjs";
import { writeCliMessage as printCliMessage } from "./cli-presentation.mjs";
import { codexProcessInvocation } from "./owned-process.mjs";
import {
  validateCodexConfigDocument,
  validateDebugConfigDocument,
} from "./gateway-config.mjs";
import {
  loadManagedModelProviderDefinitions,
  isManagedProviderModelValid,
  opencodeGoProviderDefinition,
  sharedManagedProviderDefinition,
} from "./model-provider-definitions.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomPrimaryCredential,
  loadConfiguredManagedPrimaryCredential,
  loadOpenAiBaseUrl,
  loadManagedModelProviderSettings,
  managedProviderDirectory,
  readManagedMarker,
  providerMetricsSocketPath,
  validateConfiguredModelProviders,
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
  const providerDefinitions = new Map(
    loadManagedModelProviderDefinitions(runtime.environment)
      .map((definition) => [definition.id, definition]),
  );
  const settingsFingerprints = new Map([...providerDefinitions.values()]
    .filter(definition => readManagedMarker(runtime.environment, definition))
    .map(definition => [definition.id, readAppServerProviderSettingsFingerprint(definition.id, runtime.environment)]));
  const initialSettings = loadManagedModelProviderSettings(runtime.environment);
  const settingsSnapshots = new Map([...settingsFingerprints].map(([provider, fingerprint]) => [provider, {
    fingerprint, defaultModel: initialSettings.find(value => value.provider === provider)?.model ?? null,
  }]));
  const appServerRuntime = resolveAppServerRuntime(
    runtime.document,
    runtime.dataDir,
    runtime.environment,
  );
  for (const [provider, fingerprint] of settingsFingerprints) {
    if (readAppServerProviderSettingsFingerprint(provider, runtime.environment) !== fingerprint) {
      throw new Error("Provider 设置在启动材料读取期间发生变化");
    }
  }
  const customPrimaryProvider = loadConfiguredCustomPrimaryModelProvider(runtime.environment);
  // The proxy and its credential must retain the same configuration until the host restarts.
  const customPrimaryCredential = customPrimaryProvider === undefined ? undefined
    : loadConfiguredCustomPrimaryCredential(runtime.environment, customPrimaryProvider);
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
    AggregateModelProxy,
    ChatCompletionsBridge,
    chatBridgeRequestTimeoutMs,
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
  const proxyProviderIds = new Map();
  const proxyTargetSignatures = new Map();
  const providerProxyRuntimes = new ProviderProxyRuntimeRegistry(async (
    provider,
    options,
  ) => {
    const metricsProvider = proxyProviderIds.get(provider) ?? provider;
    const definition = providerDefinitions.get(provider) ?? sharedManagedProviderDefinition(provider);
    let bridge;
    const guardedDefinition = definition && ["ocg", "opencode-go", "ccg", "clp"].includes(definition.storageId ?? definition.id)
      ? definition : undefined;
    const modelGuard = guardedDefinition
      ? new ProviderModelGuard(join(managedProviderDirectory(runtime.environment, guardedDefinition),
        guardedDefinition.catalogFileName), model => isManagedProviderModelValid(guardedDefinition, model))
      : isResponsesProvider(metricsProvider)
        ? new ProviderModelGuard(responsesProviderCatalogPath(runtime.environment, metricsProvider), model =>
          typeof model === "string" && model.trim() === model && model.length > 0 && model.length <= 200 && !/\p{Cc}/u.test(model), {
          parseCatalog: parseResponsesModelCatalog,
          blockedPaths: [
            `${responsesProviderCatalogPath(runtime.environment, metricsProvider)}.pending`,
            responsesContextSyncPath(runtime.environment),
          ],
        })
        : undefined;
    if (definition?.upstreamWireApi === "chat_completions") {
      const clinePass = definition.storageId === "clp" || definition.id === "clp";
      bridge = new ChatCompletionsBridge({ ...options,
        clinePass,
        ...(modelGuard ? { readClinePassModelCapabilities: (model, signal) => modelGuard.modelCapabilities(model, signal) } : {}),
        onError: () => proxySelector.invalidate(),
        ...(validatedCodex.upstream_user_agent ? { upstreamUserAgent: validatedCodex.upstream_user_agent } : {}),
      });
      try { await bridge.start(); }
      catch (error) { await modelGuard?.close(); throw error; }
      options = bridge.proxyOptions();
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
              label: metricsProvider,
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
      ...(!bridge && modelGuard ? { isModelEnabled: (model, signal) => modelGuard.isEnabled(model, signal) } : {}),
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
          : provider === "clp"
            ? managedAccountProxyOptions(clineAccounts, clinePassProviderId, "CLP")
            : provider === "ccg"
              ? managedAccountProxyOptions(ccgAccounts, ccgProviderId, "CCG")
              : {
                onMetrics: (metrics) => sendProviderProxyMetrics(
                  providerMetricsSocketPath(socketPath, metricsProvider),
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
    try { await modelProxy.start(); } catch (error) {
      try { await bridge?.close(); } finally { await modelGuard?.close(); }
      throw error;
    }
    const proxyRuntime = {
      baseUrl: `http://${modelProxy.address()}`,
      proxy: bridge || modelGuard ? { close: async () => {
        try { await modelProxy.close(); } finally {
          try { await bridge?.close(); } finally { await modelGuard?.close(); }
        }
      } } : modelProxy,
    };
    console.log(
      `${opencodeGo ? "opencode-go" : provider} 模型统计代理已启动：${modelProxy.address()}`,
    );
    return proxyRuntime;
  });
  const proxyTargetSignature = options => JSON.stringify([
    options.upstreamHost, options.upstreamPort ?? null,
    options.upstreamProtocol ?? "https", options.upstreamBasePath ?? "/",
  ]);
  const startProviderProxy = (provider, options) => {
    if (!proxyTargetSignatures.has(provider)) proxyTargetSignatures.set(provider, proxyTargetSignature(options));
    return providerProxyRuntimes.ensure(provider, options).catch(error => {
      if (!providerProxyRuntimes.get(provider)) {
        proxyTargetSignatures.delete(provider);
        proxyProviderIds.delete(provider);
      }
      throw error;
    });
  };
  const closeProviderProxy = async (proxy) => {
    for (const key of proxyTargetSignatures.keys()) {
      if (providerProxyRuntimes.get(key)?.proxy !== proxy) continue;
      proxyTargetSignatures.delete(key);
      proxyProviderIds.delete(key);
    }
    providerProxyRuntimes.remove(proxy);
    await proxy.close();
  };
  const goAccounts = loadOpencodeGoAccounts(runtime.environment);
  const clineAccounts = loadClinePassAccounts(runtime.environment);
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
  const providerSettingsFingerprint = provider => provider === aggregateProviderId
    ? readAggregateProviderSettingsFingerprint(runtime.environment, appServerRuntime.aggregateMembers)
    : readAppServerProviderSettingsFingerprint(provider, runtime.environment);
  const prepareProviderSettings = (provider) => {
    const aggregate = provider === aggregateProviderId;
    if (!providerDefinitions.has(provider) && !aggregate) return undefined;
    const fingerprint = providerSettingsFingerprint(provider);
    validateConfiguredModelProviders(runtime.environment);
    const next = resolveAppServerRuntime(runtime.document, runtime.dataDir, runtime.environment);
    const aggregateMaterial = aggregate
      ? loadAggregateModelMaterial(runtime.environment, appServerRuntime.aggregateMembers) : undefined;
    const defaultModel = aggregate ? aggregateMaterial.defaultModel
      : loadManagedModelProviderSettings(runtime.environment).find(value => value.provider === provider)?.model ?? null;
    if (providerSettingsFingerprint(provider) !== fingerprint || aggregateMaterial && aggregateMaterial.fingerprint !== fingerprint) {
      throw new Error("Provider 设置在读取期间发生变化");
    }
    if (JSON.stringify(next.topology) !== JSON.stringify(appServerRuntime.topology)) {
      throw new Error("App Server 拓扑已变化，需要显式重启服务");
    }
    const managed = managedByProvider.get(provider);
    const material = next.managedProviders.find(value => value.provider === provider);
    if (managed && !material) throw new Error("Provider 启动材料不可用");
    if (managed && !aggregate) managed.runtime = material;
    return { fingerprint, defaultModel };
  };
  const confirmProviderSettings = (provider, snapshot) => {
    if (!snapshot) return;
    if (providerSettingsFingerprint(provider) !== snapshot.fingerprint) {
      throw new Error("Provider 设置在应用期间发生变化");
    }
    settingsSnapshots.set(provider, snapshot);
  };
  const instanceLaunches = new Map();
  let aggregateProxy;
  let aggregateGuard;
  const aggregateProxyKeys = new Set();
  const closeAggregateProxy = async () => {
    const current = aggregateProxy;
    const guard = aggregateGuard;
    aggregateProxy = undefined;
    aggregateGuard = undefined;
    const results = await Promise.allSettled([current?.close(), guard?.close()]);
    for (const key of aggregateProxyKeys) providerProxyRuntimes.removeUser(key, aggregateProviderId);
    const orphanedProxies = [...aggregateProxyKeys].filter(key => !providerProxyIsInUse(key))
      .map(key => providerProxyRuntimes.get(key)?.proxy).filter(Boolean);
    aggregateProxyKeys.clear();
    const proxyResults = await Promise.allSettled(orphanedProxies.map(proxy => closeProviderProxy(proxy)));
    const errors = [...results, ...proxyResults].filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "聚合模型资源未能完全关闭");
  };
  const prepareAggregateRuntime = async (snapshot) => {
    const material = loadAggregateModelMaterial(runtime.environment, appServerRuntime.aggregateMembers);
    if (material.fingerprint !== snapshot.fingerprint || material.defaultModel !== snapshot.defaultModel) {
      throw new Error("聚合设置在启动材料读取期间发生变化");
    }
    // The App Server reads the derived catalogue, so guard its exact launch bytes
    // as well as the authoritative sources used by the routes and settings IPC.
    aggregateGuard = new AggregateMaterialGuard([...material.files, {
      path: join(runtime.dataDir, "runtime", "aggregate-models.json"), maximumBytes: 8_388_608,
      digest: createHash("sha256").update(`${JSON.stringify(material.catalog, null, 2)}\n`).digest("hex"),
    }]);
    const token = randomBytes(32).toString("hex");
    const urls = new Map();
    for (const profile of material.profiles) {
      let key = sharedProviderProxyKey(profile.provider);
      const options = await proxyOptionsForUrl(new URL(profile.baseUrl));
      const signature = proxyTargetSignature(options);
      // A live standalone custom instance can retain its original upstream.
      // The new aggregate snapshot gets a separate proxy with the same metrics owner.
      if (!providerDefinitions.has(profile.provider)
        && (customSwitchingProvidersById.get(profile.provider)?.baseUrl !== profile.baseUrl
          || proxyTargetSignatures.has(key) && proxyTargetSignatures.get(key) !== signature)) {
        key = `${profile.provider}@${createHash("sha256").update(signature).digest("hex")}`;
        proxyProviderIds.set(key, profile.provider);
      }
      providerProxyRuntimes.addUser(key, aggregateProviderId);
      aggregateProxyKeys.add(key);
      const started = await startProviderProxy(key, options);
      const accountId = proxyAccountId(profile.provider);
      urls.set(profile.provider, accountId === undefined ? started.baseUrl : `${started.baseUrl}/go/${accountId}`);
    }
    const guard = aggregateGuard;
    aggregateProxy = new AggregateModelProxy({ token, assertCurrent: signal => guard.check(signal),
      routes: new Map([...material.routes].map(([slug, route]) => [slug, {
        model: route.model, apiKey: route.apiKey, baseUrl: urls.get(route.provider),
        timeoutMs: providerDefinitions.get(route.provider)?.upstreamWireApi === "chat_completions"
          ? chatBridgeRequestTimeoutMs + 10_000 : 65_000,
      }])),
    });
    await aggregateProxy.start();
    const baseUrl = `http://${aggregateProxy.address()}`;
    const argumentsList = aggregateLaunchArguments(material, runtime.dataDir, baseUrl);
    await guard.check();
    return { baseUrl, arguments: argumentsList,
      childEnvironment: { [aggregateTokenEnvironmentKey]: token } };
  };
  const children = [];
  const childrenByProvider = new Map();
  const providerProxyIsInUse = (proxyKey) =>
    providerProxyRuntimes.hasUsers(proxyKey)
    || sharedProviderProxyKey(primaryProvider) === proxyKey;
  let watchChild;
  let detachChild;
  let lifecycle;
  const ensureInstance = (provider) => {
    if (lifecycle?.closed) throw new Error("App Server 正在关闭，不能启动 Provider");
    const existing = instanceLaunches.get(provider);
    if (existing) return existing;
    const launch = (async () => {
      if (provider === primaryProvider) {
        const runningChild = childrenByProvider.get(provider);
        if (runningChild) {
          await waitForAppServer(socketPath, runningChild, provider, runtime.environment);
          return;
        }
        if (await appServerSocketAcceptsWebSocket(socketPath, runtime.environment)) return;
        await prepareAppServerSocketPaths([socketPath], runtime.environment);
        settingsSnapshots.delete(provider);
        const snapshot = prepareProviderSettings(provider);
        const primaryChildEnvironment = withoutManagedProviderApiKeys(runtime.environment);
        let primaryCredential;
        if (primaryProvider === "openai") {
          const currentCustomPrimary = loadConfiguredCustomPrimaryModelProvider(runtime.environment);
          if (JSON.stringify(currentCustomPrimary) !== JSON.stringify(customPrimaryProvider)) {
            const message = "自定义固定 Provider 配置已变化；请运行 codexc restart all 后重试";
            printCliMessage("failure", message);
            throw new Error(message);
          }
          const currentCredential = customPrimaryProvider === undefined ? undefined
            : loadConfiguredCustomPrimaryCredential(runtime.environment, customPrimaryProvider);
          if (currentCredential?.environmentKey !== customPrimaryCredential?.environmentKey
            || currentCredential?.apiKey !== customPrimaryCredential?.apiKey) {
            const message = "自定义固定 Provider 凭据已变化；请运行 codexc restart all 后重试";
            printCliMessage("failure", message);
            throw new Error(message);
          }
          primaryCredential = customPrimaryCredential;
        } else {
          primaryCredential = loadConfiguredManagedPrimaryCredential(runtime.environment);
        }
        if (primaryCredential) primaryChildEnvironment[primaryCredential.environmentKey] = primaryCredential.apiKey;
        if (snapshot && providerSettingsFingerprint(provider) !== snapshot.fingerprint) {
          throw new Error("Provider 凭据在启动期间发生变化");
        }
        const attachment = desktopAppAttachment?.provider === provider ? desktopAppAttachment : undefined;
        const primaryAppServerArguments = [
          ...primaryArguments,
          ...(attachment
            ? [
                "-c",
                `${macDesktopAppPluginEnabledConfigKey}=${attachment.toolsEnabled}`,
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
        if (lifecycle?.closed) throw new Error("App Server 正在关闭，不能启动 Provider");
        const child = attachment
          ? spawnMacDesktopHostedCodex(
              attachment,
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
        try {
          await waitForAppServer(socketPath, child, provider, runtime.environment);
          confirmProviderSettings(provider, snapshot);
          settingsRecoveryRequired.delete(provider);
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
      const aggregate = provider === aggregateProviderId;
      if (!managed || (!definition && !customDefinition && !aggregate) || !managed.socketPath) {
        throw new Error(`模型 Provider 未配置独立 App Server：${provider}`);
      }
      const runningChild = childrenByProvider.get(provider);
      if (runningChild) {
        await waitForAppServer(managed.socketPath, runningChild, provider, runtime.environment);
        return;
      }
      if (await appServerSocketAcceptsWebSocket(managed.socketPath, runtime.environment)) return;
      await prepareAppServerSocketPaths([managed.socketPath], runtime.environment);
      const proxyKey = sharedProviderProxyKey(provider);
      if (!aggregate) providerProxyRuntimes.addUser(proxyKey, provider);
      let proxy;
      let child;
      try {
        settingsSnapshots.delete(provider);
        const snapshot = prepareProviderSettings(provider);
        const startedProxy = aggregate ? await prepareAggregateRuntime(snapshot) : await startProviderProxy(
          proxyKey,
          isGoProvider(provider)
            ? await goProxyOptions()
            : await proxyOptionsForUrl(new URL(
                definition?.baseUrl ?? customDefinition.baseUrl,
              )),
        );
        proxy = startedProxy.proxy;
        if (aggregate) managed.runtime = { provider, arguments: startedProxy.arguments, childEnvironment: startedProxy.childEnvironment };
        const providerBaseUrl = proxyAccountId(provider) !== undefined
          ? `${startedProxy.baseUrl}/go/${proxyAccountId(provider)}`
          : startedProxy.baseUrl;
        const argumentsList = aggregate ? managed.runtime.arguments : withProviderBaseUrl(
          managed.runtime.arguments,
          provider,
          providerBaseUrl,
        );
        const attachment = desktopAppAttachment?.provider === provider ? desktopAppAttachment : undefined;
        const managedAppServerArguments = [
          ...argumentsList,
          ...(attachment ? ["-c", `${macDesktopAppPluginEnabledConfigKey}=${attachment.toolsEnabled}`] : []),
          "app-server",
          "--listen",
          `unix://${managed.socketPath}`,
        ];
        const managedSpawnOptions = {
          stdio: "inherit",
          env: {
            ...withoutManagedProviderApiKeys(runtime.environment),
            ...managed.runtime.childEnvironment,
          },
          cwd: defaultWorkspace.cwd,
        };
        if (lifecycle?.closed) throw new Error("App Server 正在关闭，不能启动 Provider");
        child = attachment
          ? spawnMacDesktopHostedCodex(attachment, managedAppServerArguments, managedSpawnOptions)
          : spawnCodexProcess(runtime.environment.CODEX_BINARY, managedAppServerArguments, managedSpawnOptions, runtime.environment);
        children.push(child);
        childrenByProvider.set(provider, child);
        await waitForAppServer(
          managed.socketPath,
          child,
          provider,
          runtime.environment,
          "模型 Provider App Server",
        );
        if (aggregate) await aggregateGuard.check();
        confirmProviderSettings(provider, snapshot);
        settingsRecoveryRequired.delete(provider);
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
        if (aggregate) {
          try { await closeAggregateProxy(); }
          catch (proxyError) { cleanupError ??= proxyError; }
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
    if (provider === aggregateProviderId) await closeAggregateProxy();
    // The baseline belongs to the terminated instance, even if proxy cleanup fails.
    settingsSnapshots.delete(provider);
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
  const settingsRecoveryRequired = new Set();
  const applyProviderSettings = async (provider, signal, canApply) => {
    // Initial primary startup also uses ensureInstance, before any IPC operation
    // owns the Provider queue. Do not reconcile against its unconfirmed baseline.
    await instanceLaunches.get(provider);
    signal.throwIfAborted();
    // Managed settings may change launch material, never the host's socket topology.
    // Account addition/removal and primary-provider changes require explicit service management.
    if (!providerDefinitions.has(provider) && provider !== aggregateProviderId) throw new Error("Provider 不支持受管设置应用");
    const fingerprint = providerSettingsFingerprint(provider);
    if (!settingsRecoveryRequired.has(provider) && settingsSnapshots.get(provider)?.fingerprint === fingerprint) {
      return { applied: true, changed: false };
    }
    const managed = managedByProvider.get(provider);
    if (provider !== primaryProvider && !managed) throw new Error("Provider 启动材料不可用");
    const targetSocket = provider === primaryProvider ? socketPath : managed.socketPath;
    const running = childrenByProvider.has(provider);
    if (running) {
      const { CodexAppServerClient, createAppServerTransport, JsonRpcClient } = await import("../dist/codex-client/index.js");
      signal.throwIfAborted();
      const client = new CodexAppServerClient(new JsonRpcClient(createAppServerTransport(
        { kind: "local-app-server", socketPath: targetSocket },
        {
          createCodexProcessInvocation: args => codexProcessInvocation(
            runtime.environment.CODEX_BINARY, args, runtime.environment,
          ),
          terminateCodexProcess: terminateChildProcess,
          connectTimeoutMs: 3_000,
        },
      ), 5_000), { sandbox: "read-only" });
      const cancel = () => { void client.close().catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await client.connect();
        signal.throwIfAborted();
        if (await client.countActiveLoadedThreads() > 0) return { applied: false, reason: "active" };
      } finally {
        signal.removeEventListener("abort", cancel);
        await client.close();
      }
    } else if (await appServerSocketAcceptsWebSocket(targetSocket, runtime.environment)) {
      throw new Error("拒绝重启未受监管的 App Server");
    }
    // Lease acquisition can race the asynchronous authoritative read. The owner
    // registers leases before queueing them, so this guard sees pending TUI clients too.
    if (!canApply()) return { applied: false, reason: "leased" };
    signal.throwIfAborted();
    const snapshot = prepareProviderSettings(provider);
    if (running || settingsRecoveryRequired.has(provider)) {
      if (running) {
        settingsRecoveryRequired.add(provider);
        await releaseInstance(provider);
        supervisorOwner.markReleased(provider);
      }
      // Once released, restore the shared instance even if the requester disconnected.
      await ensureInstance(provider);
      settingsRecoveryRequired.delete(provider);
      supervisorOwner.markRunning(provider);
    }
    // A cancelled caller receives no confirmation, but a completed restoration
    // still establishes the host's actual baseline for the next Gateway.
    confirmProviderSettings(provider, snapshot);
    return { applied: true, changed: true };
  };
  const attachDesktopApp = async ({ provider, appPath, pipePath, toolsEnabled }, signal, canAttach) => {
    if (
      process.platform !== "darwin"
      || validatedCodex.desktop_app?.enabled !== true
      || primaryProvider !== "openai"
    ) {
      throw new Error("macOS Codex Desktop App 共享未启用");
    }
    const managed = managedByProvider.get(provider);
    if (provider !== primaryProvider && !managed) {
      throw new Error("Desktop 目标 Provider 未配置独立 App Server");
    }
    const targetSocket = provider === primaryProvider ? socketPath : managed.socketPath;
    const nextAttachment = { ...validateMacDesktopAppAttachment({
      appPath,
      pipePath,
      toolsEnabled,
      codexBinary: runtime.environment.CODEX_BINARY,
      environment: runtime.environment,
    }), provider };
    await instanceLaunches.get(provider);
    signal.throwIfAborted();
    const ensureManagedTargetInstance = async () => {
      if (!childrenByProvider.has(provider)
        && await appServerSocketAcceptsWebSocket(targetSocket, runtime.environment)) {
        throw new Error("Desktop 目标 App Server 不受当前服务监管");
      }
      await ensureInstance(provider);
      if (!childProcessIsRunning(childrenByProvider.get(provider))) {
        throw new Error("Desktop 目标 App Server 不受当前服务监管");
      }
      supervisorOwner.markRunning(provider);
    };
    // An idle release is still managed: restore the child before querying its
    // authoritative state. Never take over a live socket owned by another process.
    await ensureManagedTargetInstance();
    signal.throwIfAborted();
    if (desktopAppAttachment?.provider === provider && desktopAppAttachment.key === nextAttachment.key) {
      if (!canAttach()) throw new Error("Desktop 目标 App Server 正被其他客户端租约占用");
      return;
    }
    const { CodexAppServerClient, createAppServerTransport, JsonRpcClient } = await import("../dist/codex-client/index.js");
    signal.throwIfAborted();
    const client = new CodexAppServerClient(new JsonRpcClient(createAppServerTransport(
      { kind: "local-app-server", socketPath: targetSocket },
      {
        createCodexProcessInvocation: args => codexProcessInvocation(
          runtime.environment.CODEX_BINARY, args, runtime.environment,
        ),
        terminateCodexProcess: terminateChildProcess,
        connectTimeoutMs: 3_000,
      },
    ), 5_000), { sandbox: "read-only" });
    const cancel = () => { void client.close().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await client.connect();
      signal.throwIfAborted();
      if (await client.countActiveLoadedThreads() > 0) {
        throw new Error("Desktop 目标 App Server 仍有活动任务，不能附加 Desktop Host");
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await client.close();
    }
    // Pending Remote leases are registered before their queued ensure. Check
    // again after the RPC read; this does not freeze Turns from external clients.
    if (!canAttach()) throw new Error("Desktop 目标 App Server 正被其他客户端租约占用");
    signal.throwIfAborted();
    const previousAttachment = desktopAppAttachment;
    try {
      const released = await releaseInstance(provider);
      if (!released) {
        throw new Error("Desktop 目标 App Server 不受当前服务监管");
      }
      supervisorOwner.markReleased(provider);
      if (!canAttach()) throw new Error("Desktop 目标 App Server 正被其他客户端租约占用");
      signal.throwIfAborted();
      desktopAppAttachment = nextAttachment;
      await ensureManagedTargetInstance();
    } catch (error) {
      desktopAppAttachment = previousAttachment;
      let recoveryError;
      try {
        await releaseInstance(provider);
        await ensureManagedTargetInstance();
      } catch (recoveryFailure) {
        recoveryError = recoveryFailure;
      }
      if (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "Desktop Host 附加失败，且目标 App Server 未能恢复",
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
    await prepareAppServerSocketPaths(appServerRuntime.socketPaths, runtime.environment);
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
      if (definition.webSearch === "disabled") primaryArguments.push("-c", 'web_search="disabled"');
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
    lifecycle = forwardChildrenLifecycle(children, closeResources);
    watchChild = lifecycle.watchChild;
    detachChild = lifecycle.detachChild;
    supervisorOwner = new AppServerSupervisorOwner(
      socketPath,
      appServerRuntime.topology,
      {
        ensureProvider: ensureInstance,
        releaseProvider: releaseInstance,
        applyProviderSettings,
        providerSettingsSnapshot: provider => settingsSnapshots.get(provider),
        attachDesktopApp,
        detachDesktopApp,
        desktopAppProviderSelectionEnabled: validatedCodex.desktop_app?.enabled === true
          && primaryProvider === "openai",
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
    await ensureInstance(primaryProvider);
    supervisorOwner.markRunning(primaryProvider);
    if (validatedCodex.desktop_app?.enabled === true && process.platform === "win32") {
      await ensureInstance(primaryProvider);
      desktopAppBridge = await startDesktopAppBridge({
        port: validatedCodex.desktop_app.port,
        socketPath,
        primaryProvider,
        providerSocketPaths: Object.fromEntries([...managedByProvider]
          .map(([provider, managed]) => [provider, managed.socketPath])),
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
    try {
      if (lifecycle) await lifecycle.close();
      else await closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "App Server 启动失败且资源清理未完成", { cause: cleanupError });
    }
    throw error;
  }

  async function closeResources() {
    const results = await Promise.allSettled([
      () => proxySelector.close(),
      () => desktopAppBridge?.close(),
      () => supervisorOwner?.close(),
      () => closeAggregateProxy(),
      ...providerProxyRuntimes.values().map(({ proxy }) => () => proxy.close()),
      ...[...upstreamAgents].map(agent => () => agent.destroy()),
    ].map(operation => Promise.resolve().then(operation)));
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "App Server 资源清理未完成");
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
      || /^CODEX_CONNECT_[A-Z0-9_]+_API_KEY_PRIMARY_[a-f0-9]{32}$/u.test(key)
      || /^CODEX_CONNECT_CUSTOM_[A-F0-9]+(?:_PRIMARY_[a-f0-9]{32})?_API_KEY$/u.test(key)
    ) {
      delete childEnvironment[key];
    }
  }
  return childEnvironment;
}

function spawnCodexProcess(codexBinary, args, options, environment) {
  const invocation = codexProcessInvocation(
    codexBinary,
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
  environment,
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
        if (await appServerSocketAcceptsWebSocket(socketPath, environment)) {
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
  let closeTask;
  const watchers = new Map();
  let cleanup = () => undefined;
  const close = (initialSignal) => {
    if (closeTask) return closeTask;
    settled = true;
    cleanup();
    for (const [child, watcher] of watchers) {
      child.off("error", watcher.onError);
      child.off("exit", watcher.onExit);
    }
    watchers.clear();
    closeTask = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(closeResources),
        ...[...children].map(async (child) => {
          let signalError;
          if (initialSignal) {
            try { signalChildProcesses([child], initialSignal); } catch (error) { signalError = error; }
          }
          try { await terminateChildProcess(child); }
          catch (error) { throw new AggregateError([...(signalError ? [signalError] : []), error], "App Server 子进程清理失败", { cause: error }); }
          if (signalError) throw signalError;
        }),
      ]);
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "App Server 资源清理未完成");
    });
    return closeTask;
  };
  const finish = (code, signal, error, initialSignal = "SIGTERM") => {
    if (settled) return;
    void (async () => {
      await close(initialSignal);
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
  return { watchChild, detachChild, close, get closed() { return settled; } };
}
