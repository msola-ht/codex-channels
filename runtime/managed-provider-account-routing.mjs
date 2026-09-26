import { clinePassAccountIdFromProvider, clinePassProviderId, isClinePassAccountProvider, loadClinePassAccounts } from "./cline-pass-accounts.mjs";
import {
  deepseekAccountIdFromProvider,
  deepseekProviderId,
  isDeepseekAccountProvider,
  loadDeepseekAccounts,
} from "./deepseek-accounts.mjs";
import {
  ccgAccountIdFromProvider,
  ccgProviderId,
  isCcgAccountProvider,
  loadCcgAccounts,
} from "./ccg-accounts.mjs";
import {
  isOpencodeGoProvider,
  loadOpencodeGoAccounts,
  opencodeGoAccountIdFromProvider,
  opencodeGoProviderId,
} from "./opencode-go-accounts.mjs";

const families = Object.freeze([
  {
    proxyKey: "clp",
    matches: isClinePassAccountProvider,
    accountId: clinePassAccountIdFromProvider,
    providerId: clinePassProviderId,
    loadAccounts: loadClinePassAccounts,
  },
  {
    proxyKey: "deepseek",
    matches: isDeepseekAccountProvider,
    accountId: deepseekAccountIdFromProvider,
    providerId: deepseekProviderId,
    loadAccounts: loadDeepseekAccounts,
  },
  {
    proxyKey: "ocg",
    matches: isOpencodeGoProvider,
    accountId: opencodeGoAccountIdFromProvider,
    providerId: opencodeGoProviderId,
    loadAccounts: loadOpencodeGoAccounts,
  },
  {
    proxyKey: "ccg",
    matches: isCcgAccountProvider,
    accountId: ccgAccountIdFromProvider,
    providerId: ccgProviderId,
    loadAccounts: loadCcgAccounts,
  },
]);

export function managedProviderAccountIdFromProvider(provider) {
  return families.find((family) => family.matches(provider))?.accountId(provider);
}

export function sharedProviderProxyKey(provider) {
  return families.find((family) => family.matches(provider))?.proxyKey ?? provider;
}

export function resolveDefaultManagedProvider(providers, environment = process.env) {
  const candidates = [...new Set(providers)];
  if (candidates.length < 2) return undefined;
  const family = families.find((candidate) =>
    candidates.every((provider) => candidate.matches(provider)));
  if (family === undefined) return undefined;
  const account = family.loadAccounts(environment).find((candidate) => candidate.default);
  if (account === undefined) return undefined;
  const provider = family.providerId(account.id);
  return candidates.includes(provider) ? provider : undefined;
}
