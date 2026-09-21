import { execFile, execFileSync } from "node:child_process";

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
  const explicit = Object.fromEntries(PROXY_FIELDS.map(([field]) => [
    field,
    Object.hasOwn(configured, field) ? stringValue(configured[field]) : inherited[field],
  ]));
  const needsSystemProxy = !PROXY_FIELDS.some(
    ([field]) => field !== "no_proxy" && explicit[field],
  );
  const system = needsSystemProxy ? readSystemProxy(platform) : {};
  const resolved = Object.fromEntries(PROXY_FIELDS.map(([field]) => [
    field,
    Object.hasOwn(configured, field) ? explicit[field] : explicit[field] || stringValue(system[field]),
  ]));

  return Object.fromEntries(PROXY_FIELDS.flatMap(([field, upper]) => (
    resolved[field] || Object.hasOwn(configured, field)
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

export function createRefreshableHttpProxySelector(
  configured = {},
  environment = process.env,
  options = {},
) {
  let resolved;
  let inFlight;
  let generation = 0;
  const controller = new AbortController();
  const platform = options.platform ?? process.platform;
  const readSystemProxy = options.readSystemProxy ?? optionalSystemProxyAsync;
  const resolve = async () => {
    controller.signal.throwIfAborted();
    if (resolved) return resolved;
    if (!inFlight) {
      const currentGeneration = generation;
      inFlight = (async () => {
        let needsSystemProxy = false;
        const explicit = resolveProxyEnvironment(configured, environment, {
          readSystemProxy: () => { needsSystemProxy = true; return {}; },
        });
        const system = needsSystemProxy
          ? await readSystemProxy(platform, controller.signal)
          : undefined;
        controller.signal.throwIfAborted();
        const result = system === undefined ? explicit : resolveProxyEnvironment(
          configured, environment, { readSystemProxy: () => system },
        );
        if (generation === currentGeneration) resolved = result;
        return result;
      })().finally(() => { inFlight = undefined; });
    }
    return await inFlight;
  };
  const select = async (target, explicitProxy) => {
    const proxy = await resolve();
    controller.signal.throwIfAborted();
    return selectHttpProxyUrl({
      http: proxy.HTTP_PROXY,
      https: proxy.HTTPS_PROXY,
      all: proxy.ALL_PROXY,
      no: proxy.NO_PROXY,
    }, target, explicitProxy);
  };
  const invalidate = () => {
    generation += 1;
    resolved = undefined;
  };
  return {
    async validate(target, explicitProxy) {
      try {
        await select(target, explicitProxy);
      } finally {
        invalidate();
      }
    },
    select,
    invalidate,
    async close() {
      controller.abort();
      await inFlight?.catch(() => undefined);
    },
  };
}

async function optionalSystemProxyAsync(platform, signal) {
  try {
    return await readSystemProxyAsync(platform, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    // Match startup discovery: system settings are optional (e.g. headless Linux).
    return {};
  }
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

export async function readSystemProxyAsync(platform = process.platform, signal) {
  signal?.throwIfAborted();
  const deadline = globalThis.AbortSignal.timeout(2_000);
  const querySignal = signal ? globalThis.AbortSignal.any([signal, deadline]) : deadline;
  const runQuery = (executable, args) => new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: "utf8", signal: querySignal, timeout: 2_000,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  if (platform === "darwin") {
    return readMacSystemProxy(await runQuery("/usr/sbin/scutil", ["--proxy"]));
  }
  if (platform !== "linux") return {};
  const settings = new Map();
  const readSetting = async (schema, key) => {
    const value = await runQuery("gsettings", ["get", schema, key]);
    settings.set(`${schema}:${key}`, value);
    return value;
  };
  if (unquote(await readSetting("org.gnome.system.proxy", "mode")) !== "manual") return {};
  try {
    await readSetting("org.gnome.system.proxy", "use-same-proxy");
  } catch (error) {
    if (querySignal.aborted) throw error;
    // This optional GNOME key is absent on some supported installations.
    settings.set("org.gnome.system.proxy:use-same-proxy", "false");
  }
  const sameProxy = unquote(settings.get("org.gnome.system.proxy:use-same-proxy")) === "true";
  for (const protocol of sameProxy ? ["http", "socks"] : ["http", "https", "socks"]) {
    await readSetting(`org.gnome.system.proxy.${protocol}`, "host");
    await readSetting(`org.gnome.system.proxy.${protocol}`, "port");
  }
  await readSetting("org.gnome.system.proxy", "ignore-hosts");
  return readGnomeSystemProxy((schema, key) => settings.get(`${schema}:${key}`));
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
