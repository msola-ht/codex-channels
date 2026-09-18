import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  createRefreshableHttpProxySelector,
  readGnomeSystemProxy,
  readMacSystemProxy,
  resolveHttpProxyUrl,
  resolveProxyEnvironment,
  selectHttpProxyUrl,
} from "../runtime/network-proxy.mjs";
import { NetworkProxyWatcher } from "../src/bootstrap/network-proxy-watcher.js";

describe("network proxy discovery", async () => {
  it("keeps a single asynchronous discovery in flight and cancels it on stop", async () => {
    let signal: AbortSignal | undefined;
    let resolveRead!: (proxy: { https?: string }) => void;
    const readSystemProxy = vi.fn((value: AbortSignal) => {
      signal = value;
      return new Promise<{ https?: string }>((resolve) => { resolveRead = resolve; });
    });
    const warn = vi.fn();
    const watcher = new NetworkProxyWatcher({
      environment: {}, logger: { warn } as unknown as Logger,
      configured: {}, initialProxy: {}, readSystemProxy,
    });
    const first = watcher.checkNow();
    const second = watcher.checkNow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readSystemProxy).toHaveBeenCalledOnce();
    const stopped = watcher.stop();
    expect(signal?.aborted).toBe(true);
    resolveRead({ https: "http://127.0.0.1:7890" });
    await Promise.all([first, second, stopped]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("observes system HTTPS changes when only NO_PROXY is configured", async () => {
    let systemProxy: { https?: string } = {};
    const warn = vi.fn();
    const watcher = new NetworkProxyWatcher({
      environment: {},
      logger: { warn } as unknown as Logger,
      configured: { no_proxy: "localhost,127.0.0.1" },
      initialProxy: { no: "localhost,127.0.0.1" },
      readSystemProxy: async () => systemProxy,
    });
    systemProxy = { https: "http://127.0.0.1:7890" };
    await watcher.checkNow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("retains the last route after a failed read and continues observing", async () => {
    const warn = vi.fn();
    const proxy = { https: "http://127.0.0.1:7890" };
    const readSystemProxy = vi.fn()
      .mockRejectedValueOnce(new Error("query timeout"))
      .mockResolvedValueOnce(proxy)
      .mockResolvedValueOnce({ https: "http://127.0.0.1:7891" });
    const watcher = new NetworkProxyWatcher({
      environment: {}, logger: { warn } as unknown as Logger,
      configured: {}, initialProxy: proxy, readSystemProxy,
    });
    await watcher.checkNow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("检查失败"));
    await watcher.checkNow();
    expect(warn).toHaveBeenCalledOnce();
    await watcher.checkNow();
    expect(warn).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("only warns once per changed route and stops observing on shutdown", async () => {
    let systemProxy: { https?: string } = {};
    const warn = vi.fn();
    const watcher = new NetworkProxyWatcher({
      environment: {},
      logger: { warn } as unknown as Logger,
      configured: {},
      initialProxy: {},
      readSystemProxy: async () => systemProxy,
    });
    systemProxy = { https: "http://127.0.0.1:7890" };
    await watcher.checkNow();
    await watcher.checkNow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("codexc service restart all"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("codexc start"));
    await watcher.stop();
    systemProxy = {};
    await watcher.checkNow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("notices a system proxy appearing during construction", async () => {
    const warn = vi.fn();
    const watcher = new NetworkProxyWatcher({
      environment: {},
      logger: { warn } as unknown as Logger,
      configured: {},
      initialProxy: {},
      readSystemProxy: async () => ({ https: "http://127.0.0.1:7890" }),
    });
    await watcher.checkNow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not warn for an explicitly configured proxy", async () => {
    const warn = vi.fn();
    const watcher = new NetworkProxyWatcher({
      environment: {},
      logger: { warn } as unknown as Logger,
      configured: { https_proxy: "http://configured.example:8080" },
      initialProxy: { https: "http://configured.example:8080" },
      readSystemProxy: async () => ({ https: "http://127.0.0.1:7890" }),
    });
    await watcher.checkNow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes system proxy selection only after the caller invalidates a failed route", () => {
    let systemProxy: { https_proxy?: string } = {};
    const readSystemProxy = vi.fn(() => systemProxy);
    const selector = createRefreshableHttpProxySelector({}, {}, {
      platform: "darwin",
      readSystemProxy,
    });

    expect(selector.select("https://api.openai.com/v1/responses")).toBeUndefined();
    systemProxy = { https_proxy: "http://127.0.0.1:7890" };
    expect(selector.select("https://api.openai.com/v1/responses")).toBeUndefined();

    selector.invalidate();
    expect(selector.select("https://api.openai.com/v1/responses"))
      .toBe("http://127.0.0.1:7890/");
    expect(readSystemProxy).toHaveBeenCalledTimes(2);
  });

  it("validates the initial route without keeping the discovery snapshot", () => {
    let systemProxy = { https_proxy: "not-a-url" };
    const selector = createRefreshableHttpProxySelector({}, {}, {
      platform: "darwin",
      readSystemProxy: () => systemProxy,
    });

    expect(() => selector.validate("https://api.openai.com/v1/responses"))
      .toThrow("HTTP(S) 代理不是有效 URL");

    systemProxy = { https_proxy: "http://127.0.0.1:7890" };
    expect(selector.select("https://api.openai.com/v1/responses"))
      .toBe("http://127.0.0.1:7890/");
  });

  it("does not add undefined proxy keys when no source defines a proxy", () => {
    expect(resolveProxyEnvironment(
      {},
      {},
      { platform: "linux", readSystemProxy: () => ({}) },
    )).toEqual({});
  });

  it("selects and validates an HTTP(S) client proxy from one resolved environment", () => {
    expect(resolveHttpProxyUrl(
      "http://explicit.example:8080",
      {
        HTTPS_PROXY: "http://environment-https.example:8443",
        HTTP_PROXY: "http://environment-http.example:8080",
      },
    )).toBe("http://explicit.example:8080/");
    expect(resolveHttpProxyUrl(undefined, {
      HTTPS_PROXY: "http://environment-https.example:8443",
      HTTP_PROXY: "http://environment-http.example:8080",
    })).toBe("http://environment-https.example:8443/");
    expect(resolveHttpProxyUrl(undefined, {
      HTTP_PROXY: "http://environment-http.example:8080",
    })).toBe("http://environment-http.example:8080/");
    expect(resolveHttpProxyUrl(undefined, {})).toBeUndefined();
    expect(() => resolveHttpProxyUrl("not-a-url")).toThrow("HTTP(S) 代理不是有效 URL");
    expect(() => resolveHttpProxyUrl("socks5://proxy.example:1080")).toThrow(
      "HTTP(S) 客户端代理只支持 http:// 或 https://",
    );
  });

  it("selects one HTTP(S) proxy route for a target and honors NO_PROXY", () => {
    const proxy = {
      http: "http://http.example:8080",
      https: "http://https.example:8443",
      all: "http://all.example:9000",
      no: "localhost,.internal.example,api.example:8443,[::1]",
    };

    expect(selectHttpProxyUrl(proxy, "https://open.feishu.cn")).toBe(
      "http://https.example:8443/",
    );
    expect(selectHttpProxyUrl(proxy, "http://open.feishu.cn")).toBe(
      "http://http.example:8080/",
    );
    expect(selectHttpProxyUrl(proxy, "https://service.internal.example")).toBeUndefined();
    expect(selectHttpProxyUrl(proxy, "https://api.example:8443")).toBeUndefined();
    expect(selectHttpProxyUrl(proxy, "https://api.example:9443")).toBe(
      "http://https.example:8443/",
    );
    expect(selectHttpProxyUrl(proxy, "https://[::1]")).toBeUndefined();
  });

  it("keeps an explicit client proxy ahead of shared NO_PROXY", () => {
    expect(selectHttpProxyUrl(
      {
        https: "http://shared.example:8443",
        no: "api.telegram.org",
      },
      "https://api.telegram.org",
      "http://telegram.example:8080",
    )).toBe("http://telegram.example:8080/");
  });

  it("fails closed when the selected shared proxy is invalid or unsupported", () => {
    expect(() => selectHttpProxyUrl(
      { https: "not-a-url" },
      "https://open.feishu.cn",
    )).toThrow("HTTP(S) 代理不是有效 URL");
    expect(() => selectHttpProxyUrl(
      { all: "socks5://127.0.0.1:1080" },
      "https://open.feishu.cn",
    )).toThrow("HTTP(S) 客户端代理只支持 http:// 或 https://");
    expect(selectHttpProxyUrl(
      {
        all: "socks5://127.0.0.1:1080",
        no: ".feishu.cn",
      },
      "https://open.feishu.cn",
    )).toBeUndefined();
  });

  it("prefers explicit config, then inherited environment, then the system proxy", () => {
    const readSystemProxy = vi.fn(() => ({
      http_proxy: "http://system-http:8080",
      https_proxy: "http://system-https:8443",
      all_proxy: "socks5h://system-socks:1080",
      no_proxy: "system.local",
    }));

    const resolved = resolveProxyEnvironment(
      {
        https_proxy: "http://configured-https:9443",
        no_proxy: "configured.local",
      },
      {
        HTTP_PROXY: "http://environment-http:9080",
      },
      { platform: "linux", readSystemProxy },
    );

    expect(resolved).toEqual({
      HTTP_PROXY: "http://environment-http:9080",
      HTTPS_PROXY: "http://configured-https:9443",
      ALL_PROXY: "socks5h://system-socks:1080",
      NO_PROXY: "configured.local",
      http_proxy: "http://environment-http:9080",
      https_proxy: "http://configured-https:9443",
      all_proxy: "socks5h://system-socks:1080",
      no_proxy: "configured.local",
    });
    expect(readSystemProxy).toHaveBeenCalledWith("linux");
  });

  it("does not inspect system settings when config and environment resolve every field", () => {
    const readSystemProxy = vi.fn(() => ({ http_proxy: "http://system:8080" }));

    resolveProxyEnvironment(
      {
        http_proxy: "http://configured:8080",
        https_proxy: "http://configured:8080",
        all_proxy: "socks5h://configured:1080",
        no_proxy: "localhost",
      },
      {},
      { platform: "darwin", readSystemProxy },
    );

    expect(readSystemProxy).not.toHaveBeenCalled();
  });

  it("reads enabled macOS HTTP and HTTPS proxies", () => {
    const resolved = readMacSystemProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7898
  HTTPSProxy : ::1
  ProxyAutoConfigEnable : 0
}
`);

    expect(resolved).toEqual({
      http_proxy: "http://127.0.0.1:7897",
      https_proxy: "http://[::1]:7898",
    });
  });

  it("reads a manual GNOME proxy without credentials", () => {
    const settings = new Map([
      ["org.gnome.system.proxy:mode", "'manual'"],
      ["org.gnome.system.proxy:use-same-proxy", "false"],
      ["org.gnome.system.proxy.http:host", "'127.0.0.1'"],
      ["org.gnome.system.proxy.http:port", "7890"],
      ["org.gnome.system.proxy.https:host", "'127.0.0.1'"],
      ["org.gnome.system.proxy.https:port", "7891"],
      ["org.gnome.system.proxy.socks:host", "''"],
      ["org.gnome.system.proxy.socks:port", "0"],
      ["org.gnome.system.proxy:ignore-hosts", "['localhost', '127.0.0.0/8']"],
    ]);

    expect(readGnomeSystemProxy((schema, key) => settings.get(`${schema}:${key}`) ?? "")).toEqual({
      http_proxy: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7891",
      no_proxy: "localhost,127.0.0.0/8",
    });
  });

  it("ignores GNOME automatic proxy configuration because PAC is unsupported", () => {
    expect(readGnomeSystemProxy(() => "'auto'")).toEqual({});
  });
});
