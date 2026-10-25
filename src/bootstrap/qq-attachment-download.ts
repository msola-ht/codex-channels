import { lookup } from "node:dns/promises";
import type { Agent, ClientRequest } from "node:http";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { QqNetwork } from "../surfaces/index.js";

// Conservative destination policy, not a claim that all other addresses are reachable.
const excluded = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) excluded.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16], ["3fff::", 20]] as const) {
  excluded.addSubnet(address, prefix, "ipv6");
}
const nativeGlobal = new BlockList();
nativeGlobal.addSubnet("2000::", 3, "ipv6");

function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !excluded.check(address, "ipv4")
    : family === 6 && nativeGlobal.check(address, "ipv6") && !excluded.check(address, "ipv6");
}

/** Owns download sockets separately from token/API fetch; no credentials or redirects. */
export function createQqAttachmentDownloader(network: Pick<QqNetwork, "agentForUrl" | "releaseAgent">): {
  download: QqNetwork["downloadAttachment"];
  close(): Promise<void>;
} {
  const lifetime = new AbortController();
  const requests = new Set<ClientRequest>();
  const closing = new Set<Promise<void>>();
  let cleanupFailed = false;
  return {
    async download(url, caller, beforeDownload) {
      const signal = AbortSignal.any([caller, lifetime.signal, AbortSignal.timeout(30_000)]);
      signal.throwIfAborted();
      beforeDownload();
      if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) {
        throw new Error("QQ 附件地址无效");
      }
      const host = url.hostname.replace(/^\[|\]$/gu, "");
      const addresses = isIP(host) ? [{ address: host }] : await abortable(lookup(host, { all: true, verbatim: true }), signal);
      if (!addresses.length || addresses.some(value => !publicAddress(value.address))) throw new Error("QQ 附件目的地不受支持");
      signal.throwIfAborted();
      beforeDownload();
      const address = addresses[0]!.address;
      const agent: Agent | undefined = network.agentForUrl(url.href, signal);
      const release = () => {
        if (!agent) return;
        const work = network.releaseAgent(agent).catch(() => { cleanupFailed = true; }).finally(() => closing.delete(work));
        closing.add(work);
      };
      try {
        return await new Promise<Awaited<ReturnType<QqNetwork["downloadAttachment"]>>>((resolve, reject) => {
          // CONNECT and direct TCP both use the pinned IP. Host/SNI/certificate
          // identity remain the original hostname; the proxy cannot resolve it again.
          const req = request({ protocol: "https:", hostname: address, port: 443,
            path: `${url.pathname}${url.search}`, method: "GET", agent: agent ?? false, signal,
            ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: true,
            checkServerIdentity: (_hostname, certificate) => checkServerIdentity(host, certificate),
            headers: { Host: url.host, "Accept-Encoding": "identity" },
          }, response => {
            if (response.statusCode !== 200) { response.destroy(); reject(new Error("QQ 附件下载未确认")); return; }
            const length = response.headers["content-length"];
            if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) {
              response.destroy(); reject(new Error("QQ 附件长度无效")); return;
            }
            resolve({ stream: response, ...(length === undefined ? {} : { contentLength: Number(length) }) });
          });
          requests.add(req);
          req.once("error", reject);
          req.once("close", () => { requests.delete(req); release(); });
          req.end();
        });
      } catch (error) {
        // Request close owns release once construction succeeded. An agent that
        // never acquired a request is still released on network shutdown.
        throw new Error("QQ 附件连接未确认", { cause: error });
      }
    },
    async close() {
      lifetime.abort();
      await Promise.all([...requests].map(req => new Promise<void>(resolve => {
        req.once("close", resolve); req.destroy();
      })));
      await Promise.all([...closing]);
      if (cleanupFailed) throw new Error("QQ 附件资源关闭未确认");
    },
  };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("QQ 附件下载已取消"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
