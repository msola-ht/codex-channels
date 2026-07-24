import { describe, expect, it, vi } from "vitest";

import {
  readGnomeSystemProxy,
  readMacSystemProxy,
  resolveProxyEnvironment,
} from "../runtime/network-proxy.mjs";

describe("network proxy discovery", () => {
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
