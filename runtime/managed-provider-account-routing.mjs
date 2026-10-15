import { managedProviderAccountFamilies } from "./model-provider-definitions.mjs";

export function managedProviderAccountIdFromProvider(provider) {
  return managedProviderAccountFamilies.find((family) => family.matches(provider))?.accountId(provider);
}

export function sharedProviderProxyKey(provider) {
  return managedProviderAccountFamilies.find((family) => family.matches(provider))?.proxyKey ?? provider;
}

export function resolveDefaultManagedProvider(providers, environment = process.env) {
  const candidates = [...new Set(providers)];
  if (candidates.length < 2) return undefined;
  const family = managedProviderAccountFamilies.find((candidate) =>
    candidates.every((provider) => candidate.matches(provider)));
  if (family === undefined) return undefined;
  const account = family.loadAccounts(environment).find((candidate) => candidate.default);
  if (account === undefined) return undefined;
  const provider = family.providerId(account.id);
  return candidates.includes(provider) ? provider : undefined;
}
