import { isCustomCatalogProvider, responsesProviderCatalogPath, parseResponsesModelCatalog, responsesContextSyncPath } from "./model-provider-responses-catalog.mjs";
import { readCodexProxySettings } from "./codex-proxy-env.mjs";
import { resolveCodexRequestIdentity } from "./codex-request-identity.mjs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { aggregateProviderId, aggregateTokenEnvironmentKey, aggregateLaunchArguments, loadAggregateModelMaterial,
  readAggregateProviderSettingsFingerprint, AggregateProviderTopologyChangedError } from "./aggregate-model-provider.mjs";
import { readCustomProviderUpstreamWireApi } from "./model-provider-upstream-metadata.mjs";
import { AggregateMaterialGuard } from "./aggregate-material-guard.mjs";
import { ProviderModelGuard } from "./provider-model-guard.mjs";
import { providerCatalogIsolationPath } from "./provider-catalog-isolation.mjs";
import { assertProviderModelRequestPolicy, assertProviderModelRetryPolicy } from "./model-request-policy.mjs";

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
  managedProviderAccountFamilies,
  isManagedProviderModelValid,
  opencodeGoProviderDefinition,
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
  opencodeGoAccountIdFromProvider,
  opencodeGoProviderId,
} from "./opencode-go-accounts.mjs";
import {
  managedProviderAccountIdFromProvider,
} from "./managed-provider-account-routing.mjs";
import { createOpencodeGoQuotaWindowsProvider } from "./opencode-go-quota-windows.mjs";
import { createRefreshableHttpProxySelector } from "./network-proxy.mjs";
import {
  childProcessIsRunning,
  installProcessSignalHandlers,
  installServiceControlHandler,
  signalChildProcesses,
  terminateChildProcess,
} from "./process-lifecycle.mjs";
import { createProxyFetch } from "./proxy-fetch.mjs";
import { ProviderProxyRuntimeRegistry } from "./provider-proxy-runtime-registry.mjs";
import { isolateProviderCredential } from "./provider-credential-policy.mjs";
import { serviceShutdownTimeoutMs } from "./shutdown-budget.mjs";

export async function runAppServerService(runtime, resolveDefaultWorkspace) {
  const children = [];
  let closeResources = async () => undefined;
  let finishStartup;
  const startupFinished = new Promise(resolve => { finishStartup = resolve; });
  const lifecycle = forwardChildrenLifecycle(children, async () => {
    await startupFinished;
    await closeResources();
  });
  let startupError;
  try {
    await startAppServerService(runtime, resolveDefaultWorkspace, children, lifecycle,
      close => { closeResources = close; });
  } catch (error) {
    startupError = error;
  } finally {
    finishStartup();
  }
  if (startupError || lifecycle.closed) {
    try {
      await lifecycle.close();
    } catch (cleanupError) {
      throw new AggregateError([...(startupError ? [startupError] : []), cleanupError],
        "App Server 启动失败且资源清理未完成", { cause: cleanupError });
    }
    if (startupError && !lifecycle.stopRequested
      && !(startupError instanceof AppServerStoppedError)) throw startupError;
  }
}

class AppServerStoppedError extends Error {
  constructor() { super("App Server 正在关闭，不能启动 Provider"); }
}

async function startAppServerService(runtime, resolveDefaultWorkspace, children, lifecycle, registerCloseResources) {
  const assertRunning = () => {
    if (lifecycle.closed) throw new AppServerStoppedError();
  };
  assertRunning();
  const validatedCodex = validateCodexConfigDocument(runtime.document.codex ?? {});
  const { upstreamUserAgent } = resolveCodexRequestIdentity(validatedCodex);
  // Version expansion can exceed the original UA's validated length.
  validateCodexConfigDocument({ upstream_user_agent: upstreamUserAgent });
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
    || [...customSwitchingProviderIds].some(id => !isCustomCatalogProvider(id))
    ? writeCustomOfficialModelCatalog(
        runtime.environment,
        runtime.environment.CODEX_BINARY,
      )
    : undefined;
  const customSwitchingProviders = officialCatalogPath === undefined
    ? appServerRuntime.customSwitchingProviders
    : appServerRuntime.customSwitchingProviders.map((provider) => ({
        ...provider,
        arguments: withOfficialModelCatalog(provider.arguments, isCustomCatalogProvider(provider.provider) ? responsesProviderCatalogPath(runtime.environment, provider.provider) : officialCatalogPath),
      }));
  const managedProviders = officialCatalogPath === undefined
    ? appServerRuntime.managedProviders
    : appServerRuntime.managedProviders.map((provider) =>
        customSwitchingProviderIds.has(provider.provider)
          ? {
              ...provider,
              arguments: withOfficialModelCatalog(provider.arguments, isCustomCatalogProvider(provider.provider) ? responsesProviderCatalogPath(runtime.environment, provider.provider) : officialCatalogPath),
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
    pruneModelTrafficDumpSessionsAsync,
    sendProviderProxyMetrics,
  } = await import("../dist/provider-proxy/index.js");
  assertRunning();
  const upstreamAgents = new Set();
  const upstreamAgentsByProxyUrl = new Map();
  const proxySelector = createRefreshableHttpProxySelector(
    readCodexProxySettings(runtime.environment),
    process.env,
  );
  registerCloseResources(() => proxySelector.close());
  let supervisorOwner;
  let desktopAppBridge;
  let trafficMaintenance;
  const upstreamAgentFor = async (upstreamUrl, signal) => {
    signal?.throwIfAborted();
    const proxyUrl = await proxySelector.select(upstreamUrl);
    signal?.throwIfAborted();
    assertRunning();
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
  // 上游接口：受管 Provider 来自定义；自定义第三方 Provider 来自其网关侧元数据。
  // 聚合会给自定义成员派生 `provider@<hash>` 路由键，因此先解析真实 Provider 身份。
  const upstreamWireApiFor = (provider, routeKey = provider) => {
    const managed = providerDefinitions.get(routeKey);
    if (managed?.upstreamWireApi !== undefined) return managed.upstreamWireApi;
    if (customPrimaryProvider !== undefined
      && (provider === customPrimaryProvider.id || routeKey === primaryProvider)) {
      return customPrimaryProvider.upstreamWireApi;
    }
    return customSwitchingProvidersById.get(provider)?.upstreamWireApi;
  };
  const providerProxyRuntimes = new ProviderProxyRuntimeRegistry(async (
    provider,
    options,
    retain,
  ) => {
    assertRunning();
    const metricsProvider = proxyProviderIds.get(provider) ?? provider;
    // 固定自定义 Provider 保留主实例的 IPC 路由键；目录和上游能力使用实际 Provider 身份。
    const upstreamProvider = provider === primaryProvider
      ? customPrimaryProvider?.id ?? metricsProvider
      : metricsProvider;
    const definition = providerDefinitions.get(provider);
    let bridge;
    let modelProxy;
    const ownedResources = new Set();
    const proxyRuntime = { baseUrl: "", proxy: { close: async () => {
      const errors = [];
      // Stop ingress before its bridge and guard, retaining only failed owners.
      for (const resource of [...ownedResources].reverse()) {
        try { await resource.close(); ownedResources.delete(resource); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "模型代理资源未能完全关闭");
    } } };
    retain(proxyRuntime);
    const guardedDefinition = definition?.accountId !== undefined
      ? definition : undefined;
    const modelGuard = guardedDefinition
      ? new ProviderModelGuard(join(managedProviderDirectory(runtime.environment, guardedDefinition),
        guardedDefinition.catalogFileName), model => isManagedProviderModelValid(guardedDefinition, model), {
        blockedPaths: [providerCatalogIsolationPath(runtime.environment),
          `${join(managedProviderDirectory(runtime.environment, guardedDefinition), guardedDefinition.catalogFileName)}.settings-pending`],
      })
      : isCustomCatalogProvider(upstreamProvider)
        ? new ProviderModelGuard(responsesProviderCatalogPath(runtime.environment, upstreamProvider), model =>
          typeof model === "string" && model.trim() === model && model.length > 0 && model.length <= 200 && !/\p{Cc}/u.test(model), {
          parseCatalog: parseResponsesModelCatalog,
          blockedPaths: [
            `${responsesProviderCatalogPath(runtime.environment, upstreamProvider)}.pending`,
            responsesContextSyncPath(runtime.environment),
            providerCatalogIsolationPath(runtime.environment),
          ],
        })
        : undefined;
    if (modelGuard) ownedResources.add(modelGuard);
    // 官方 OpenAI 端点理解 Codex 私有输入项；自定义固定 Provider 复用 openai 路由键但换成第三方上游。
    // 聚合快照可能派生带摘要的代理键，固定自定义 Provider 则复用 openai 路由键。
    const officialOpenAiRoute = upstreamProvider === "openai";
    let bridgedClinePass = false;
    if (upstreamWireApiFor(upstreamProvider, provider) === "chat_completions") {
      const clinePass = definition?.storageId === "clp" || definition?.id === "clp";
      bridgedClinePass = clinePass;
      bridge = new ChatCompletionsBridge({ ...options,
        clinePass,
        ...(modelGuard ? { readClinePassModelCapabilities: (model, signal) => modelGuard.modelCapabilities(model, signal) } : {}),
        onError: () => proxySelector.invalidate(),
        ...(upstreamUserAgent ? { upstreamUserAgent } : {}),
      });
      ownedResources.add(bridge);
      await bridge.start();
      assertRunning();
      options = bridge.proxyOptions();
    }
    const optionsWithUserAgent = {
      ...options,
      ...(upstreamUserAgent
        ? { upstreamUserAgent }
        : {}),
      ...(!validatedDebug.model_traffic_dump
        ? {}
        : {
            trafficDump: {
              directory: trafficDumpDirectory,
              inputItems: validatedDebug.model_traffic_input_items,
              itemMaxBytes: validatedDebug.model_traffic_item_max_bytes,
              retentionDays: validatedDebug.model_traffic_retention_days,
              // Fixed custom Providers use the primary IPC route, but their
              // persisted capture identity must describe the actual Provider.
              label: upstreamProvider,
            },
          }),
    };
    const accountFamily = managedProviderAccountFamilies.find(family => family.matches(upstreamProvider));
    const accountId = accountFamily?.accountId(upstreamProvider);
    const opencodeGo = accountFamily?.proxyKey === "ocg";
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
    modelProxy = new ProviderProxy("127.0.0.1:0", {
      ...optionsWithUserAgent,
      // CLP 桥在桥内按目录校验模型；通用 Chat 桥没有该校验，继续由统计代理拒绝目录外或已停用模型。
      ...(modelGuard && !bridgedClinePass ? isCustomCatalogProvider(upstreamProvider)
        ? { readModelCapabilities: (model, signal) => modelGuard.modelCapabilities(model, signal) }
        : { isModelEnabled: (model, signal) => modelGuard.isEnabled(model, signal) } : {}),
      // 除官方 OpenAI 端点外的 Responses 上游都不理解 Codex 私有输入项与参数标记，
      // 必须在上游收到正文前归一化；Chat 上游由桥转换，不在此处改写。
      ...(!bridge && !officialOpenAiRoute ? { normalizeResponsesInput: true } : {}),
      ...(opencodeGo
        ? {
            accountIds: [accountId],
            defaultAccountId: accountId,
            quotaWindowsProvider: (requestedAccountId, signal) => {
              const quota = opencodeGoQuotaWindows.get(
                requestedAccountId ?? accountId,
              );
              return quota ? quota(signal) : Promise.resolve(null);
            },
            onMetrics: (metrics, requestedAccountId) => {
              const targetAccountId = requestedAccountId ?? accountId;
              if (targetAccountId === undefined) return undefined;
              const targetProvider = opencodeGoProviderId(targetAccountId);
              return sendProviderProxyMetrics(
                providerMetricsSocketPath(socketPath, targetProvider),
                metrics,
              );
            },
          }
        : accountFamily
          ? managedAccountProxyOptions([{id: accountId, default: true}], accountFamily.providerId, accountFamily.definition.displayName)
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
    ownedResources.add(modelProxy);
    await modelProxy.start();
    assertRunning();
    proxyRuntime.baseUrl = `http://${modelProxy.address()}`;
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
    assertRunning();
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
    const keys = [...proxyTargetSignatures.keys()].filter(key => providerProxyRuntimes.get(key)?.proxy === proxy);
    await providerProxyRuntimes.close(proxy);
    for (const key of keys) {
      proxyTargetSignatures.delete(key);
      proxyProviderIds.delete(key);
    }
  };
  const accountsByProxyKey = new Map(managedProviderAccountFamilies.map(family => [
    family.proxyKey, family.loadAccounts(runtime.environment),
  ]));
  const goAccounts = accountsByProxyKey.get("ocg");
  const proxyAccountId = managedProviderAccountIdFromProvider;
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
    assertRunning();
    return {
      upstreamHost: upstreamUrl.hostname,
      ...(upstreamUrl.port ? { upstreamPort: Number(upstreamUrl.port) } : {}),
      upstreamProtocol: upstreamUrl.protocol === "http:" ? "http" : "https",
      upstreamBasePath: upstreamUrl.pathname,
      resolveUpstream: async (_headers, signal) => {
        const agent = await upstreamAgentFor(upstreamUrl, signal);
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
  const assertAggregateProtocols = (profiles) => {
    for (const profile of profiles) {
      if (isCustomCatalogProvider(profile.provider)
        && profile.upstreamWireApi !== customSwitchingProvidersById.get(profile.provider)?.upstreamWireApi) {
        // Member proxies retain the host's launch protocol, including proxies
        // created later for a refreshed URL. Only a full host restart replaces it.
        throw new AggregateProviderTopologyChangedError();
      }
    }
  };
  const providerSettingsFingerprint = (provider) => {
    if (provider !== aggregateProviderId) return readAppServerProviderSettingsFingerprint(provider, runtime.environment);
    // Check even before the first aggregate instance exists, and before an
    // unchanged/active result can acknowledge or defer new protocol material.
    assertCurrentAggregateProtocols();
    return readAggregateProviderSettingsFingerprint(runtime.environment, appServerRuntime.aggregateMembers);
  };
  const assertCurrentAggregateProtocols = () => assertAggregateProtocols(
    appServerRuntime.aggregateMembers.filter(isCustomCatalogProvider).map(provider => ({
      provider, upstreamWireApi: readCustomProviderUpstreamWireApi(runtime.environment, provider),
    })),
  );
  const prepareProviderSettings = (provider) => {
    const aggregate = provider === aggregateProviderId;
    if (!providerDefinitions.has(provider) && !aggregate) return undefined;
    const fingerprint = providerSettingsFingerprint(provider);
    validateConfiguredModelProviders(runtime.environment);
    const next = resolveAppServerRuntime(runtime.document, runtime.dataDir, runtime.environment);
    const aggregateMaterial = aggregate
      ? loadAggregateModelMaterial(runtime.environment, appServerRuntime.aggregateMembers) : undefined;
    if (aggregateMaterial) assertAggregateProtocols(aggregateMaterial.profiles);
    const defaultModel = aggregate ? aggregateMaterial.defaultModel
      : loadManagedModelProviderSettings(runtime.environment).find(value => value.provider === provider)?.model ?? null;
    if (providerSettingsFingerprint(provider) !== fingerprint || aggregateMaterial && aggregateMaterial.fingerprint !== fingerprint) {
      throw new Error("Provider 设置在读取期间发生变化");
    }
    if (JSON.stringify(next.topology) !== JSON.stringify(appServerRuntime.topology)) {
      throw Object.assign(new Error("App Server 拓扑已变化，需要显式重启服务"), { code: "PROVIDER_TOPOLOGY_CHANGED" });
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
  let aggregateClosing;
  let aggregateCleanupRequired = false;
  const aggregateProxyKeys = new Set();
  const closeAggregateProxy = () => {
    if (aggregateClosing) return aggregateClosing;
    aggregateCleanupRequired = true;
    const current = aggregateProxy;
    const guard = aggregateGuard;
    const closure = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(async () => { await current?.close(); if (aggregateProxy === current) aggregateProxy = undefined; }),
        Promise.resolve().then(async () => { await guard?.close(); if (aggregateGuard === guard) aggregateGuard = undefined; }),
      ]);
      // A surviving aggregate listener must retain its member routes.
      const proxyResults = aggregateProxy ? [] : await Promise.allSettled([...aggregateProxyKeys].map(async key => {
        providerProxyRuntimes.removeUser(key, aggregateProviderId);
        if (!providerProxyIsInUse(key)) {
          const proxy = providerProxyRuntimes.get(key)?.proxy;
          if (proxy) await closeProviderProxy(proxy);
        }
        aggregateProxyKeys.delete(key);
      }));
      const errors = [...results, ...proxyResults].filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "聚合模型资源未能完全关闭");
      aggregateCleanupRequired = false;
    })().finally(() => { if (aggregateClosing === closure) aggregateClosing = undefined; });
    aggregateClosing = closure;
    return closure;
  };
  const prepareAggregateRuntime = async (snapshot) => {
    if (aggregateClosing) await aggregateClosing;
    if (aggregateCleanupRequired) await closeAggregateProxy();
    if (aggregateProxy || aggregateGuard || aggregateProxyKeys.size) {
      throw new Error("聚合模型旧资源尚未确认释放");
    }
    const material = loadAggregateModelMaterial(runtime.environment, appServerRuntime.aggregateMembers);
    assertAggregateProtocols(material.profiles);
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
      let key = profile.provider;
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
    assertRunning();
    aggregateProxy = new AggregateModelProxy({ token, assertCurrent: signal => guard.check(signal),
      routes: new Map([...material.routes].map(([slug, route]) => [slug, {
        model: route.model, apiKey: route.apiKey, baseUrl: urls.get(route.provider),
      }])),
    });
    await aggregateProxy.start();
    const baseUrl = `http://${aggregateProxy.address()}`;
    const argumentsList = aggregateLaunchArguments(material, runtime.dataDir, baseUrl);
    await guard.check();
    return { baseUrl, arguments: argumentsList,
      childEnvironment: { [aggregateTokenEnvironmentKey]: token } };
  };
  const childrenByProvider = new Map();
  const failedInstanceStarts = new Set();
  const providerProxyIsInUse = (proxyKey) =>
    providerProxyRuntimes.hasUsers(proxyKey)
    || primaryProvider === proxyKey;
  const { watchChild, detachChild } = lifecycle;
  const cleanFailedInstance = async (provider, child) => {
    failedInstanceStarts.add(provider);
    const errors = [];
    try { await terminateChildProcess(child); }
    catch (error) { errors.push(error); }
    if (childProcessIsRunning(child)) {
      // A healthy socket cannot turn an unconfirmed launch into readiness.
      // Keep both ownership indexes so release and service shutdown can retry.
      watchChild(child);
      if (!errors.length) errors.push(new Error(`App Server 子进程尚未确认退出：${provider}`));
    } else {
      detachChild(child);
      childrenByProvider.delete(provider);
      failedInstanceStarts.delete(provider);
    }
    return errors;
  };
  const temporaryClients = new Map();
  const ownTemporaryClient = (targetSocket, client) => {
    assertRunning();
    temporaryClients.set(client, { socketPath: targetSocket, active: true, closeTask: undefined });
  };
  const closeTemporaryClient = async (client, operationFailure) => {
    const owned = temporaryClients.get(client);
    if (!owned) return;
    owned.active = false;
    if (!owned.closeTask) {
      owned.closeTask = Promise.resolve().then(() => client.close()).then(() => {
        temporaryClients.delete(client);
      });
    }
    const task = owned.closeTask;
    try {
      await task;
    } catch (error) {
      if (operationFailure) {
        throw new AggregateError([operationFailure.error, error], "App Server 临时读取与连接清理均失败", {
          cause: error,
        });
      }
      throw error;
    } finally {
      if (owned.closeTask === task) owned.closeTask = undefined;
    }
  };
  const retryTemporaryClientCleanup = async (targetSocket) => {
    // Only abandoned connections are eligible: another operation may still be
    // using its own temporary connection to this same shared App Server.
    const results = await Promise.allSettled([...temporaryClients]
      .filter(([, owned]) => owned.socketPath === targetSocket && !owned.active)
      .map(([client]) => closeTemporaryClient(client)));
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "App Server 临时连接资源清理未完成");
  };
  const confirmRequestPolicy = async (targetSocket, provider) => {
    assertRunning();
    await retryTemporaryClientCleanup(targetSocket);
    const expectedProvider = provider === primaryProvider ? customPrimaryProvider?.id ?? provider : provider;
    await verifyAppServerRequestPolicy(targetSocket, expectedProvider, defaultWorkspace.cwd, runtime.environment,
      ownTemporaryClient, closeTemporaryClient);
    assertRunning();
  };
  const ensureInstance = (provider) => {
    assertRunning();
    const existing = instanceLaunches.get(provider);
    if (existing) return existing;
    const launch = (async () => {
      if (failedInstanceStarts.has(provider)) {
        throw new Error(`App Server 启动失败资源尚未确认清理，请先释放后重试：${provider}`);
      }
      if (provider === primaryProvider) {
        const runningChild = childrenByProvider.get(provider);
        if (runningChild) {
          await waitForAppServer(socketPath, runningChild, provider, runtime.environment);
          await confirmRequestPolicy(socketPath, provider);
          return;
        }
        if (await appServerSocketAcceptsWebSocket(socketPath, runtime.environment)) {
          await confirmRequestPolicy(socketPath, provider);
          return;
        }
        await prepareAppServerSocketPaths([socketPath], runtime.environment);
        settingsSnapshots.delete(provider);
        const snapshot = prepareProviderSettings(provider);
        const primaryChildEnvironment = withoutManagedProviderApiKeys(runtime.environment, customPrimaryCredential?.environmentKey);
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
        const primaryLaunch = isolateProviderCredential(
          customPrimaryProvider?.id ?? primaryProvider,
          primaryArguments,
          primaryChildEnvironment,
          primaryCredential,
        );
        if (snapshot && providerSettingsFingerprint(provider) !== snapshot.fingerprint) {
          throw new Error("Provider 凭据在启动期间发生变化");
        }
        const attachment = desktopAppAttachment?.provider === provider ? desktopAppAttachment : undefined;
        const primaryAppServerArguments = [
          ...primaryLaunch.arguments,
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
          env: primaryLaunch.childEnvironment,
          cwd: defaultWorkspace.cwd,
        };
        assertRunning();
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
          await confirmRequestPolicy(socketPath, provider);
          assertRunning();
          confirmProviderSettings(provider, snapshot);
          settingsRecoveryRequired.delete(provider);
          watchChild(child);
          console.log(`${provider} App Server 已按需启动：${socketPath}`);
        } catch (error) {
          const cleanupErrors = await cleanFailedInstance(provider, child);
          if (cleanupErrors.length) {
            throw new AggregateError(
              [error, ...cleanupErrors],
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
        await confirmRequestPolicy(managed.socketPath, provider);
        return;
      }
      if (await appServerSocketAcceptsWebSocket(managed.socketPath, runtime.environment)) {
        await confirmRequestPolicy(managed.socketPath, provider);
        return;
      }
      await prepareAppServerSocketPaths([managed.socketPath], runtime.environment);
      const proxyKey = provider;
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
        const credentials = Object.entries(managed.runtime.childEnvironment);
        if (credentials.length !== 1) throw new Error("隔离 App Server 必须使用唯一 Provider 凭据");
        const [[environmentKey, apiKey]] = credentials;
        const managedLaunch = isolateProviderCredential(provider, argumentsList,
          withoutManagedProviderApiKeys(runtime.environment, customPrimaryCredential?.environmentKey), { environmentKey, apiKey });
        const managedAppServerArguments = [
          ...managedLaunch.arguments,
          ...(attachment ? ["-c", `${macDesktopAppPluginEnabledConfigKey}=${attachment.toolsEnabled}`] : []),
          "app-server",
          "--listen",
          `unix://${managed.socketPath}`,
        ];
        const managedSpawnOptions = {
          stdio: "inherit",
          env: managedLaunch.childEnvironment,
          cwd: defaultWorkspace.cwd,
        };
        assertRunning();
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
        await confirmRequestPolicy(managed.socketPath, provider);
        if (aggregate) await aggregateGuard.check();
        assertRunning();
        confirmProviderSettings(provider, snapshot);
        settingsRecoveryRequired.delete(provider);
        watchChild(child);
        console.log(`${provider} App Server 已按需启动：${managed.socketPath}`);
      } catch (error) {
        const cleanupErrors = child ? await cleanFailedInstance(provider, child) : [];
        const childSurvives = child && childProcessIsRunning(child);
        if (!childSurvives) providerProxyRuntimes.removeUser(proxyKey, provider);
        if (!childSurvives && proxy && !providerProxyIsInUse(proxyKey)) {
          try {
            await closeProviderProxy(proxy);
          } catch (proxyError) {
            cleanupErrors.push(proxyError);
          }
        }
        if (!childSurvives && aggregate) {
          try { await closeAggregateProxy(); }
          catch (proxyError) { cleanupErrors.push(proxyError); }
        }
        if (cleanupErrors.length) {
          throw new AggregateError(
            [error, ...cleanupErrors],
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
    if (child) {
      detachChild(child, { retainOwnership: true });
      try {
        await terminateChildProcess(child);
      } catch (error) {
        if (!children.includes(child)) children.push(child);
        watchChild(child);
        throw error;
      }
      detachChild(child);
      childrenByProvider.delete(provider);
      failedInstanceStarts.delete(provider);
    }
    // The baseline belongs to the terminated instance, even if proxy cleanup fails.
    settingsSnapshots.delete(provider);
    if (provider === aggregateProviderId) await closeAggregateProxy();
    if (provider !== primaryProvider) {
      const proxyKey = provider;
      providerProxyRuntimes.removeUser(proxyKey, provider);
      if (!providerProxyIsInUse(proxyKey)) {
        const proxy = providerProxyRuntimes.get(proxyKey)?.proxy;
        if (proxy) await closeProviderProxy(proxy);
      }
    }
    if (!child) return false;
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
    if (running && !failedInstanceStarts.has(provider)) {
      await retryTemporaryClientCleanup(targetSocket);
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
      ownTemporaryClient(targetSocket, client);
      const cancel = () => { void closeTemporaryClient(client).catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      let operationFailure;
      try {
        signal.throwIfAborted();
        await client.connect();
        signal.throwIfAborted();
        if (await client.countActiveLoadedThreads() > 0) return { applied: false, reason: "active" };
      } catch (error) {
        operationFailure = { error };
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        await closeTemporaryClient(client, operationFailure);
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
    await retryTemporaryClientCleanup(targetSocket);
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
    ownTemporaryClient(targetSocket, client);
    const cancel = () => { void closeTemporaryClient(client).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    let operationFailure;
    try {
      signal.throwIfAborted();
      await client.connect();
      signal.throwIfAborted();
      if (await client.countActiveLoadedThreads() > 0) {
        throw new Error("Desktop 目标 App Server 仍有活动任务，不能附加 Desktop Host");
      }
    } catch (error) {
      operationFailure = { error };
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      await closeTemporaryClient(client, operationFailure);
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
  registerCloseResources(closeResources);
  {
    await prepareAppServerSocketPaths(appServerRuntime.socketPaths, runtime.environment);
    assertRunning();
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
        assertRunning();
        await proxySelector.validate(apiUrl);
        assertRunning();
        openAiProxyOptions = {
          upstreamHost: apiUrl.hostname,
          upstreamProtocol: "https",
          upstreamBasePath: apiUrl.pathname,
          resolveUpstream: async (headers, signal) => {
            const target = headers["chatgpt-account-id"] === undefined ? apiUrl : chatgptUrl;
            const agent = await upstreamAgentFor(target, signal);
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
      const providerKey = definition.id;
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
    assertRunning();
    supervisorOwner = new AppServerSupervisorOwner(
      socketPath,
      appServerRuntime.topology,
      {
        ensureProvider: ensureInstance,
        releaseProvider: releaseInstance,
        applyProviderSettings,
        providerSettingsSnapshot: provider => {
          // The supervisor skips applyProviderSettings while a native client
          // holds a lease. A lease cannot make a protocol change hot-applicable.
          if (provider === aggregateProviderId) assertCurrentAggregateProtocols();
          return settingsSnapshots.get(provider);
        },
        attachDesktopApp,
        detachDesktopApp,
        desktopAppProviderSelectionEnabled: validatedCodex.desktop_app?.enabled === true
          && primaryProvider === "openai",
      },
    );
    await supervisorOwner.start();
    assertRunning();
    try {
      const signal = globalThis.AbortSignal.any([lifecycle.signal, globalThis.AbortSignal.timeout(5_000)]);
      trafficMaintenance = pruneModelTrafficDumpSessionsAsync({
        directory: trafficDumpDirectory,
        retentionDays: validatedDebug.model_traffic_retention_days,
      }, signal);
      await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void trafficMaintenance.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    } catch (error) {
      const reason = lifecycle.closed ? "cancelled" : error?.name === "TimeoutError" ? "timeout" : "io";
      console.error(`模型请求转储自动清理未完成（${reason}）`);
    }
    assertRunning();
    await ensureInstance(primaryProvider);
    assertRunning();
    supervisorOwner.markRunning(primaryProvider);
    if (validatedCodex.desktop_app?.enabled === true && process.platform === "win32") {
      await ensureInstance(primaryProvider);
      assertRunning();
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
      assertRunning();
      console.log(
        `Codex Desktop App 桥已启动：127.0.0.1:${validatedCodex.desktop_app.port}`,
      );
    }
  }

  async function closeResources() {
    // Launch continuations can register proxies after their awaited start finishes.
    // Drain them before taking the resource snapshot used by cleanup.
    await Promise.allSettled([...instanceLaunches.values()]);
    const results = await Promise.allSettled([
      () => trafficMaintenance?.catch(() => undefined),
      () => proxySelector.close(),
      () => desktopAppBridge?.close(),
      () => supervisorOwner?.close(),
      () => closeAggregateProxy(),
      ...[...temporaryClients.keys()].map(client => () => closeTemporaryClient(client)),
      ...providerProxyRuntimes.values().map(({ proxy }) => () => closeProviderProxy(proxy)),
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

function withoutManagedProviderApiKeys(environment, customPrimaryEnvironmentKey) {
  const childEnvironment = { ...environment };
  const managedKeys = new Set(
    loadManagedModelProviderDefinitions(environment)
      .map(({ apiKeyEnvironmentKey }) => apiKeyEnvironmentKey),
  );
  // 旧版单账户环境变量不属于当前动态定义，仍必须从子进程环境剥离。
  managedKeys.add("CODEX_CONNECT_OPENCODE_GO_API_KEY");
  if (customPrimaryEnvironmentKey !== undefined) managedKeys.add(customPrimaryEnvironmentKey);
  for (const key of managedKeys) {
    delete childEnvironment[key];
  }
  for (const key of Object.keys(childEnvironment)) {
    if (
      process.platform === "win32" && [...managedKeys].some(name => name.toLowerCase() === key.toLowerCase())
      || /^CODEX_CONNECT_OPENCODE_GO(?:_[A-Z0-9_]+)?_API_KEY$/iu.test(key)
      || /^CODEX_CONNECT_[A-Z0-9_]+_API_KEY_PRIMARY_[a-f0-9]{32}$/iu.test(key)
      || /^CODEX_CONNECT_CUSTOM_[A-F0-9]+(?:_PRIMARY_[a-f0-9]{32})?_API_KEY$/iu.test(key)
      || /^CODEX_CONNECT_MODEL_AUTH_[A-F0-9]{32}_API_KEY$/iu.test(key)
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

/** Read merged configuration through Codex, including managed layers above CLI overrides.
 * Built-in OpenAI ignores same-name provider overlays in the locked version;
 * third-party providers must retain the explicit policy injected at launch.
 */
async function verifyAppServerRequestPolicy(socketPath, provider, cwd, environment, ownClient, closeClient) {
  const { createAppServerTransport, JsonRpcClient } = await import("../dist/codex-client/index.js");
  const rpc = new JsonRpcClient(createAppServerTransport(
    { kind: "local-app-server", socketPath },
    {
      createCodexProcessInvocation: args => codexProcessInvocation(environment.CODEX_BINARY, args, environment),
      terminateCodexProcess: terminateChildProcess,
      connectTimeoutMs: 3_000,
    },
  ), 5_000);
  ownClient(socketPath, rpc);
  let operationFailure;
  try {
    await rpc.connect();
    const response = await rpc.request({ method: "config/read", params: { cwd, includeLayers: false } }, { retryOverload: false });
    const config = response?.config;
    if (!config || (config.model_provider ?? "openai") !== provider) {
      throw new Error("App Server 当前 Provider 与受管启动策略不一致");
    }
    if (provider !== "openai") {
      const configured = config.model_providers?.[provider];
      assertProviderModelRequestPolicy(configured, true);
      assertProviderModelRetryPolicy(configured);
    }
  } catch (error) {
    operationFailure = { error };
    throw error;
  } finally {
    await closeClient(rpc, operationFailure);
  }
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
      if (settled) return;
      try {
        const acceptsWebSocket = await appServerSocketAcceptsWebSocket(socketPath, environment);
        if (settled) return;
        if (acceptsWebSocket) {
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
    if (!childProcessIsRunning(child)) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    void check();
  });
}

function forwardChildrenLifecycle(children, closeResources = async () => undefined) {
  const cancellation = new AbortController();
  let settled = false;
  let stopRequested = false;
  let closeTask;
  const watchers = new Map();
  let cleanup = () => undefined;
  const close = (initialSignal) => {
    if (closeTask) return closeTask;
    settled = true;
    cancellation.abort(new AppServerStoppedError());
    const deadline = setTimeout(() => {
      printCliMessage("failure", "App Server 停止等待超时，监管进程将以故障状态退出");
      process.exit(1);
    }, serviceShutdownTimeoutMs);
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
    // A failed cleanup can retain an owned child or an IPC handle. Keep the
    // deadline armed on failure so direct foreground entry points stay bounded.
    void closeTask.then(() => clearTimeout(deadline), () => { process.exitCode = 1; });
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
    SIGTERM: () => { stopRequested = true; finish(null, "SIGTERM", undefined, "SIGTERM"); },
    SIGINT: () => { stopRequested = true; finish(null, "SIGINT", undefined, "SIGINT"); },
  });
  const onControlMessage = (message) => {
    if (message?.type === "codexc-stop") {
      stopRequested = true;
      finish(0, null, undefined, null);
    }
  };
  const cleanupControl = installServiceControlHandler(onControlMessage);
  cleanup = () => {
    cleanupSignals();
    cleanupControl();
  };
  const watchChild = (child) => {
    if (settled) return;
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
  const detachChild = (child, { retainOwnership = false } = {}) => {
    const watcher = watchers.get(child);
    if (watcher) {
      watchers.delete(child);
      child.off("error", watcher.onError);
      child.off("exit", watcher.onExit);
    }
    if (!retainOwnership) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
    }
  };
  for (const child of children) watchChild(child);
  return { watchChild, detachChild, close, signal: cancellation.signal,
    get closed() { return settled; }, get stopRequested() { return stopRequested; } };
}
