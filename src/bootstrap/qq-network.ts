import type { Agent } from "node:http";
import type { Socket } from "node:net";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import { selectHttpProxyUrl } from "../../runtime/network-proxy.mjs";
import type { GatewayConfig } from "../config/index.js";
import type { QqNetwork } from "../surfaces/index.js";
import { createProxyFetch } from "./proxy-fetch.js";
import { createQqAttachmentDownloader } from "./qq-attachment-download.js";

// The public constructor also accepts a URL; only common TCP options are supplied.
type ProxyProtocol = `http:${string}`;

/** CONNECT owns a real socket before Node assigns it to the HTTP Agent. */
class QqConnectAgent extends HttpsProxyAgent<ProxyProtocol> {
  private readonly pending = new Set<Promise<Socket>>();
  private readonly ownedSockets = new Map<Socket, Promise<void>>();
  private closed = false;
  constructor(proxy: string, signal: AbortSignal) {
    // This signal reaches net.connect/tls.connect, including the unassigned CONNECT socket.
    super(new URL(proxy), { signal });
  }
  override connect(...args: Parameters<HttpsProxyAgent<ProxyProtocol>["connect"]>): Promise<Socket> {
    if (this.closed) return Promise.reject(new Error("QQ 代理已关闭"));
    const task = super.connect(...args).then(socket => {
      if (!socket.destroyed) {
        this.ownedSockets.set(socket, new Promise(resolve => socket.once("close", () => {
          this.ownedSockets.delete(socket);
          resolve();
        })));
        if (this.closed) socket.destroy();
      }
      return socket;
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.destroy();
    for (const socket of this.ownedSockets.keys()) socket.destroy();
    await Promise.allSettled([...this.pending]);
    await Promise.all([...this.ownedSockets.values()]);
  }
}

/** A fresh owner per QQ runtime generation; other channels' pools are untouched. */
export function createQqNetwork(proxy: GatewayConfig["networkProxy"]): QqNetwork {
  const lifetime = new AbortController();
  const agents = new Set<QqConnectAgent>();
  const dispatchers = new Set<ProxyAgent>();
  let closing: Promise<void> | undefined;
  const proxyFetch = createProxyFetch(proxy, { createDispatcher(url) {
    if (lifetime.signal.aborted) throw new Error("QQ HTTP 代理已关闭");
    const dispatcher = new ProxyAgent(url);
    dispatchers.add(dispatcher);
    return dispatcher;
  } });
  const network: QqNetwork = {
    downloadAttachment: (url, signal, beforeDownload, timeoutMs) => downloads.download(url, signal, beforeDownload, timeoutMs),
    uploadPart: (url, bytes, signal, beforeSend) => downloads.uploadPart(url, bytes, signal, beforeSend),
    uploadImageMaterial: (url, bytes, contentType, signal, beforeSend) => downloads.uploadImageMaterial(url, bytes, contentType, signal, beforeSend),
    fetchImpl(input, init) {
      const original = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = AbortSignal.any([lifetime.signal, ...(original ? [original] : [])]);
      signal.throwIfAborted();
      return proxyFetch(input, { ...init, signal });
    },
    agentForUrl(url, signal) {
      lifetime.signal.throwIfAborted();
      const endpoint = new URL(url);
      endpoint.protocol = "https:";
      const selected = selectHttpProxyUrl(proxy, endpoint.href);
      if (!selected) return undefined;
      const agent = new QqConnectAgent(selected, AbortSignal.any([signal, lifetime.signal]));
      agents.add(agent);
      return agent;
    },
    async releaseAgent(agent: Agent) {
      if (!(agent instanceof QqConnectAgent)) throw new Error("QQ 代理归属无效");
      await agent.close();
      agents.delete(agent);
    },
    close() {
      lifetime.abort();
      return closing ??= (async () => {
        const results = await Promise.allSettled([
          downloads.close(),
          ...[...agents].map(agent => agent.close()),
          ...[...dispatchers].map(dispatcher => dispatcher.destroy()),
        ]);
        if (results.some(result => result.status === "rejected")) throw new Error("QQ 代理关闭未确认");
        agents.clear();
        dispatchers.clear();
      })();
    },
  };
  const downloads = createQqAttachmentDownloader(network);
  return network;
}
