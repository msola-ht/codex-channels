import { request as httpRequest } from "node:http";

export interface ProviderProxyTestServer {
  close(): Promise<void>;
}

export async function cleanupProviderProxyTestServers(
  servers: ProviderProxyTestServer[],
): Promise<void> {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await server.close();
  }
}

export function providerProxySse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function requestProviderProxy(
  port: number,
  path: string,
  method: string,
): Promise<{ status: number }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method,
    }, (response) => {
      response.resume();
      response.on("end", () => {
        if ((response.statusCode ?? 0) >= 400) {
          rejectRequest(new ProxyStatusError(response.statusCode ?? 0));
          return;
        }
        resolveRequest({ status: response.statusCode ?? 0 });
      });
      response.on("error", rejectRequest);
    });
    request.on("error", rejectRequest);
    request.end(method === "GET" ? undefined : "{}");
  });
}

class ProxyStatusError extends Error {
  constructor(readonly status: number) {
    super(`unexpected status ${status}`);
  }
}
