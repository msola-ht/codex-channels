export interface ProxySettings {
  http_proxy?: string;
  https_proxy?: string;
  all_proxy?: string;
  no_proxy?: string;
}

export interface ProxyEnvironment {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  ALL_PROXY?: string;
  NO_PROXY?: string;
  http_proxy?: string;
  https_proxy?: string;
  all_proxy?: string;
  no_proxy?: string;
}

export interface HttpClientProxySettings {
  http?: string;
  https?: string;
  all?: string;
  no?: string;
}

export function resolveProxyEnvironment(
  configured?: ProxySettings,
  environment?: NodeJS.ProcessEnv,
  options?: {
    platform?: NodeJS.Platform;
    readSystemProxy?: (platform: NodeJS.Platform) => ProxySettings;
  },
): ProxyEnvironment;

export function resolveHttpProxyUrl(
  explicitProxy: string | undefined,
  proxyEnvironment?: ProxyEnvironment,
): string | undefined;

export function selectHttpProxyUrl(
  proxy: HttpClientProxySettings,
  target: string | URL,
  explicitProxy?: string,
): string | undefined;

export function readMacSystemProxy(output?: string): ProxySettings;

export function readGnomeSystemProxy(
  readSetting?: (schema: string, key: string) => string,
): ProxySettings;
