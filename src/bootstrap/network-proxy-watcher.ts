import type { Logger } from "pino";

import {
  resolveProxyEnvironment,
  readSystemProxyAsync,
  type HttpClientProxySettings,
  type ProxySettings,
} from "../../runtime/network-proxy.mjs";

export interface NetworkProxyWatcherOptions {
  logger: Logger;
  configured: ProxySettings;
  initialProxy: HttpClientProxySettings;
  environment?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  readSystemProxy?: (signal: AbortSignal) => Promise<HttpClientProxySettings>;
}

// Gateway cannot account for native clients' turns or own foreground processes.
export class NetworkProxyWatcher {
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly readSystemProxy: (signal: AbortSignal) => Promise<HttpClientProxySettings>;
  private readonly configured: ProxySettings;
  private readonly environment: NodeJS.ProcessEnv;
  private observedFingerprint: string;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly abort = new AbortController();
  private inFlight: Promise<void> | undefined;
  private readFailed = false;

  constructor(options: NetworkProxyWatcherOptions) {
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.readSystemProxy = options.readSystemProxy ?? readCurrentSystemProxy;
    this.configured = options.configured;
    this.environment = { ...(options.environment ?? process.env) };
    this.observedFingerprint = proxyFingerprint(options.initialProxy);
  }

  start(): void {
    if (this.stopping || this.timer) return;
    void this.checkNow();
    this.timer = setInterval(() => { void this.checkNow(); }, this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  checkNow(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.inFlight ??= this.checkOnce().catch(() => {
      if (this.stopping || this.readFailed) return;
      this.readFailed = true;
      this.logger.warn("系统代理检查失败，保留上次观察结果，等待下一次检查");
    }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async checkOnce(): Promise<void> {
    let needsSystemProxy = false;
    resolveProxyEnvironment(this.configured, this.environment, {
      readSystemProxy: () => { needsSystemProxy = true; return {}; },
    });
    if (!needsSystemProxy) return;
    const proxy = await this.readSystemProxy(this.abort.signal);
    if (this.stopping) return;
    this.readFailed = false;
    const resolved = resolveProxyEnvironment(this.configured, this.environment, {
      readSystemProxy: () => {
        return {
          ...(proxy.http === undefined ? {} : { http_proxy: proxy.http }),
          ...(proxy.https === undefined ? {} : { https_proxy: proxy.https }),
          ...(proxy.all === undefined ? {} : { all_proxy: proxy.all }),
          ...(proxy.no === undefined ? {} : { no_proxy: proxy.no }),
        };
      },
    });
    const current = proxyFingerprint({
      ...(resolved.HTTP_PROXY === undefined ? {} : { http: resolved.HTTP_PROXY }),
      ...(resolved.HTTPS_PROXY === undefined ? {} : { https: resolved.HTTPS_PROXY }),
      ...(resolved.ALL_PROXY === undefined ? {} : { all: resolved.ALL_PROXY }),
      ...(resolved.NO_PROXY === undefined ? {} : { no: resolved.NO_PROXY }),
    });
    if (current === this.observedFingerprint) return;
    this.observedFingerprint = current;
    this.logger.warn(
      "系统代理已变化；Gateway 渠道和 App Server 账户请求仍使用启动时的代理。"
      + "请在所有客户端任务结束后，后台模式执行 codexc service restart all，"
      + "前台模式停止并重新运行 codexc start；不会自动重启共享 App Server",
    );
  }
}

async function readCurrentSystemProxy(signal: AbortSignal): Promise<HttpClientProxySettings> {
  const system = await readSystemProxyAsync(process.platform, signal);
  const environment = resolveProxyEnvironment({}, {}, { readSystemProxy: () => system });
  return {
    ...(environment.HTTP_PROXY ? { http: environment.HTTP_PROXY } : {}),
    ...(environment.HTTPS_PROXY ? { https: environment.HTTPS_PROXY } : {}),
    ...(environment.ALL_PROXY ? { all: environment.ALL_PROXY } : {}),
    ...(environment.NO_PROXY ? { no: environment.NO_PROXY } : {}),
  };
}

function proxyFingerprint(proxy: HttpClientProxySettings): string {
  return JSON.stringify([proxy.http, proxy.https, proxy.all, proxy.no]
    .map((value) => value?.trim() ?? ""));
}
