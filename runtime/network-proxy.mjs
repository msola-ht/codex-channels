import { execFileSync } from "node:child_process";

const PROXY_FIELDS = [
  ["http_proxy", "HTTP_PROXY"],
  ["https_proxy", "HTTPS_PROXY"],
  ["all_proxy", "ALL_PROXY"],
  ["no_proxy", "NO_PROXY"],
];

export function resolveProxyEnvironment(
  configured = {},
  environment = process.env,
  {
    platform = process.platform,
    readSystemProxy = defaultSystemProxyReader,
  } = {},
) {
  const inherited = Object.fromEntries(PROXY_FIELDS.map(([field, upper]) => [
    field,
    stringValue(environment[upper]) || stringValue(environment[field]),
  ]));
  const needsSystemProxy = PROXY_FIELDS.some(
    ([field]) => !stringValue(configured[field]) && !inherited[field],
  );
  const system = needsSystemProxy ? readSystemProxy(platform) : {};
  const resolved = Object.fromEntries(PROXY_FIELDS.map(([field]) => [
    field,
    stringValue(configured[field]) || inherited[field] || stringValue(system[field]),
  ]));

  return Object.fromEntries(PROXY_FIELDS.flatMap(([field, upper]) => (
    resolved[field]
      ? [
          [upper, resolved[field]],
          [field, resolved[field]],
        ]
      : []
  )));
}

export function resolveHttpProxyUrl(explicitProxy, proxyEnvironment = {}) {
  const normalized = stringValue(explicitProxy)
    || stringValue(proxyEnvironment.HTTPS_PROXY)
    || stringValue(proxyEnvironment.HTTP_PROXY);
  return validateHttpProxyUrl(normalized);
}

export function selectHttpProxyUrl(proxy, target, explicitProxy) {
  const explicit = stringValue(explicitProxy);
  if (explicit) {
    return validateHttpProxyUrl(explicit);
  }
  const targetUrl = target instanceof URL ? target : new URL(target);
  if (matchesNoProxy(targetUrl, proxy.no)) {
    return undefined;
  }
  const selected = targetUrl.protocol === "http:"
    ? stringValue(proxy.http) || stringValue(proxy.all)
    : stringValue(proxy.https) || stringValue(proxy.http) || stringValue(proxy.all);
  return validateHttpProxyUrl(selected);
}

function validateHttpProxyUrl(value) {
  const normalized = stringValue(value);
  if (!normalized) {
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("HTTP(S) 代理不是有效 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HTTP(S) 客户端代理只支持 http:// 或 https://");
  }
  return parsed.toString();
}

function matchesNoProxy(targetUrl, noProxy) {
  const targetHostname = normalizedHostname(targetUrl.hostname);
  const targetPort = targetUrl.port || defaultPort(targetUrl.protocol);
  return stringValue(noProxy).split(",").some((rawEntry) => {
    const parsed = parseNoProxyEntry(rawEntry);
    if (!parsed) {
      return false;
    }
    if (parsed.hostname === "*") {
      return true;
    }
    if (parsed.port && parsed.port !== targetPort) {
      return false;
    }
    const hostname = parsed.hostname.startsWith("*.")
      ? parsed.hostname.slice(1)
      : parsed.hostname;
    return hostname.startsWith(".")
      ? targetHostname === hostname.slice(1) || targetHostname.endsWith(hostname)
      : targetHostname === hostname;
  });
}

function parseNoProxyEntry(value) {
  const entry = stringValue(value).toLowerCase();
  if (!entry) {
    return undefined;
  }
  if (entry.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/u.exec(entry);
    return match
      ? { hostname: normalizedHostname(match[1]), port: match[2] || "" }
      : { hostname: entry, port: "" };
  }
  const portMatch = /^(.*):(\d+)$/u.exec(entry);
  return {
    hostname: normalizedHostname(portMatch?.[1] ?? entry),
    port: portMatch?.[2] ?? "",
  };
}

function normalizedHostname(value) {
  const hostname = stringValue(value).toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function defaultPort(protocol) {
  if (protocol === "http:") {
    return "80";
  }
  if (protocol === "https:") {
    return "443";
  }
  return "";
}

export function readMacSystemProxy(output = run("/usr/sbin/scutil", ["--proxy"])) {
  const values = parseKeyValueOutput(output);
  return {
    ...(values.HTTPEnable === "1"
      ? proxyUrl("http", values.HTTPProxy, values.HTTPPort, "http_proxy")
      : {}),
    ...(values.HTTPSEnable === "1"
      ? proxyUrl("http", values.HTTPSProxy, values.HTTPSPort, "https_proxy")
      : {}),
  };
}

export function readGnomeSystemProxy(readSetting = gsettings) {
  if (unquote(readSetting("org.gnome.system.proxy", "mode")) !== "manual") {
    return {};
  }
  const useSameProxy = unquote(
    optionalSetting(readSetting, "org.gnome.system.proxy", "use-same-proxy"),
  ) === "true";
  const http = gnomeProxy(readSetting, "http", "http_proxy", "http");
  const https = useSameProxy
    ? (http.http_proxy ? { https_proxy: http.http_proxy } : {})
    : gnomeProxy(readSetting, "https", "https_proxy", "http");
  const socks = gnomeProxy(readSetting, "socks", "all_proxy", "socks5h");
  const ignoredHosts = parseGVariantStrings(readSetting("org.gnome.system.proxy", "ignore-hosts"));
  return {
    ...http,
    ...https,
    ...socks,
    ...(ignoredHosts.length > 0 ? { no_proxy: ignoredHosts.join(",") } : {}),
  };
}

function defaultSystemProxyReader(platform) {
  try {
    if (platform === "darwin") {
      return readMacSystemProxy();
    }
    if (platform === "linux") {
      return readGnomeSystemProxy();
    }
  } catch {
    // System proxy discovery is optional; explicit config and environment remain authoritative.
  }
  return {};
}

function parseKeyValueOutput(output) {
  const values = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/u.exec(line);
    if (match) {
      values[match[1]] = match[2];
    }
  }
  return values;
}

function proxyUrl(protocol, host, port, field) {
  const normalizedHost = stringValue(host);
  const normalizedPort = Number(port);
  if (!normalizedHost || !Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) {
    return {};
  }
  const urlHost = normalizedHost.includes(":") && !normalizedHost.startsWith("[")
    ? `[${normalizedHost}]`
    : normalizedHost;
  return { [field]: `${protocol}://${urlHost}:${normalizedPort}` };
}

function gnomeProxy(readSetting, protocol, field, urlProtocol) {
  const schema = `org.gnome.system.proxy.${protocol}`;
  return proxyUrl(
    urlProtocol,
    unquote(readSetting(schema, "host")),
    unquote(readSetting(schema, "port")),
    field,
  );
}

function parseGVariantStrings(value) {
  return [...value.matchAll(/'((?:[^'\\]|\\.)*)'/gu)]
    .map((match) => match[1].replaceAll("\\'", "'").replaceAll("\\\\", "\\"))
    .filter(Boolean);
}

function gsettings(schema, key) {
  return run("gsettings", ["get", schema, key]);
}

function optionalSetting(readSetting, schema, key) {
  try {
    return readSetting(schema, key);
  } catch {
    return "";
  }
}

function run(executable, args) {
  return execFileSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
}

function unquote(value) {
  const normalized = stringValue(value);
  if (
    normalized.length >= 2
    && ((normalized.startsWith("'") && normalized.endsWith("'"))
      || (normalized.startsWith('"') && normalized.endsWith('"')))
  ) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
