export function apiProviderResourceStateFromList(providers) {
  return providers.map(({ id, name, protocol, endpoint, hasApiKey }) => ({
    id,
    name,
    protocol,
    endpoint,
    hasApiKey: hasApiKey === true,
  }))
}

export function redactApiProviderResult(result) {
  if (!result || typeof result !== "object") return { action: "completed" }
  const provider = result.provider && typeof result.provider === "object"
    ? { id: result.provider.id, name: result.provider.name, protocol: result.provider.protocol, endpoint: result.provider.endpoint, hasApiKey: result.provider.hasApiKey }
    : result.provider
  return {
    action: result.action,
    ...(provider === undefined ? {} : { provider }),
    activation: result.activation,
    activationResult: result.activationResult,
  }
}

export function projectProviderManagementState(state) {
  const providers = []
  const addProvider = (provider) => {
    providers.push({
      ...provider,
      id: publicProviderId(provider.id),
      displayName: publicProviderDisplayName(provider.displayName, provider.id),
      model: publicProviderText(provider.model),
    })
  }
  for (const provider of state.managedProviders) {
    addProvider({
      id: provider.id,
      displayName: provider.displayName,
      kind: "managed",
      mode: provider.mode,
      state: "configured",
      model: provider.model,
      modelCount: boundedCount(provider.models.length),
      selected: state.primary.id === provider.id,
    })
  }
  for (const provider of state.customProviders.fixedCandidates) {
    addProvider({
      id: provider.id,
      displayName: provider.displayName,
      kind: "custom",
      mode: provider.active ? "exclusive" : "fixed",
      state: provider.state,
      model: null,
      modelCount: null,
      selected: provider.active,
    })
  }
  for (const provider of state.customProviders.switchingProviders) {
    addProvider({
      id: provider.id,
      displayName: provider.displayName,
      kind: "custom",
      mode: "switching",
      state: "configured",
      model: provider.model,
      modelCount: null,
      selected: state.primary.id === provider.id,
    })
  }
  for (const provider of state.customProviders.backupCandidates) {
    addProvider({
      id: provider.id,
      displayName: provider.displayName,
      kind: "custom",
      mode: "backup",
      state: "backup",
      model: null,
      modelCount: null,
      selected: provider.active,
    })
  }
  return {
    observedAt: new Date().toISOString(),
    available: true,
    configVersion: state.configVersion ?? null,
    defaults: {
      model: publicProviderText(state.defaults.model),
      reasoningEffort: publicProviderText(state.defaults.reasoningEffort),
    },
    primary: {
      id: publicProviderId(state.primary.id),
      displayName: publicProviderDisplayName(state.primary.displayName, state.primary.id),
      kind: state.primary.kind,
      mode: state.primary.mode,
    },
    providers,
    externalAgent: state.externalAgent.status === "configured"
      ? {
          status: "configured",
          provider: publicProviderId(state.externalAgent.provider),
          model: publicProviderText(state.externalAgent.model) ?? "unknown",
        }
      : { status: state.externalAgent.status },
  }
}

function publicProviderId(value) {
  return publicProviderText(value) ?? "unknown"
}

function publicProviderDisplayName(value, fallback) {
  return publicProviderText(value) ?? publicProviderId(fallback)
}

function publicProviderText(value) {
  if (typeof value !== "string") return null
  return value.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120) || null
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000 ? value : null
}
