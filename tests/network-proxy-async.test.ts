import { describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({
  execFile: vi.fn<(executable: string, args: string[], options: { signal: AbortSignal },
    callback: (error: Error | null, stdout: string) => void) => void>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: commands.execFile,
}));

import { createRefreshableHttpProxySelector, readSystemProxyAsync } from "../runtime/network-proxy.mjs";

describe("asynchronous system proxy discovery", () => {
  it("shares asynchronous request-path discovery without blocking the event loop", async () => {
    let complete!: () => void;
    commands.execFile.mockClear();
    commands.execFile.mockImplementation((_file, _args, _options, callback) => {
      complete = () => callback(null, "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890");
    });
    const selector = createRefreshableHttpProxySelector({}, {}, { platform: "darwin" });
    const first = selector.select("https://example.test");
    const second = selector.select("https://example.test");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(commands.execFile).toHaveBeenCalledOnce();
    complete();
    await expect(first).resolves.toBe("http://127.0.0.1:7890/");
    await expect(second).resolves.toBe("http://127.0.0.1:7890/");
  });

  it("cancels shared discovery on close and rejects later selections", async () => {
    commands.execFile.mockImplementation((_file, _args, options, callback) => {
      options.signal.addEventListener("abort", () => callback(new Error("cancelled"), ""), { once: true });
    });
    const selector = createRefreshableHttpProxySelector({}, {}, { platform: "darwin" });
    const pending = selector.select("https://example.test");
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await selector.close();
    await rejected;
    await expect(selector.select("https://example.test")).rejects.toThrow();
  });

  it("does not cache a discovery invalidated while it is in flight", async () => {
    let complete!: (proxy: { https_proxy: string }) => void;
    const readSystemProxy = vi.fn(() => new Promise<{ https_proxy: string }>((resolve) => {
      complete = resolve;
    }));
    const selector = createRefreshableHttpProxySelector({}, {}, { readSystemProxy });
    const pending = selector.select("https://example.test");
    selector.invalidate();
    complete({ https_proxy: "http://127.0.0.1:7890" });
    await pending;
    const next = selector.select("https://example.test");
    expect(readSystemProxy).toHaveBeenCalledTimes(2);
    complete({ https_proxy: "http://127.0.0.1:7891" });
    await expect(next).resolves.toBe("http://127.0.0.1:7891/");
  });

  it("releases a failed discovery so a later request can recover", async () => {
    const readSystemProxy = vi.fn()
      .mockRejectedValueOnce(new Error("query failed"))
      .mockResolvedValueOnce({ https_proxy: "http://127.0.0.1:7890" });
    const selector = createRefreshableHttpProxySelector({}, {}, { readSystemProxy });
    await expect(selector.select("https://example.test")).rejects.toThrow("query failed");
    await expect(selector.select("https://example.test")).resolves.toBe("http://127.0.0.1:7890/");
  });

  it("preserves explicit routing when optional system discovery is unavailable", async () => {
    commands.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error("gsettings not installed"), "");
    });
    const selector = createRefreshableHttpProxySelector(
      { https_proxy: "http://127.0.0.1:7890", no_proxy: "localhost" },
      {}, { platform: "linux" },
    );
    await expect(selector.select("https://example.test")).resolves.toBe("http://127.0.0.1:7890/");
    await expect(selector.select("https://localhost")).resolves.toBeUndefined();
  });

  it("does not query the system when explicit sources resolve every field", async () => {
    const readSystemProxy = vi.fn();
    const selector = createRefreshableHttpProxySelector({
      http_proxy: "http://127.0.0.1:7890", https_proxy: "http://127.0.0.1:7890",
      all_proxy: "http://127.0.0.1:7890", no_proxy: "localhost",
    }, {}, { readSystemProxy });
    await expect(selector.select("https://example.test")).resolves.toBe("http://127.0.0.1:7890/");
    expect(readSystemProxy).not.toHaveBeenCalled();
  });

  it("leaves the event loop available and propagates cancellation to the command", async () => {
    let signal: AbortSignal | undefined;
    commands.execFile.mockImplementation((_file, _args, options, callback) => {
      signal = options.signal;
      options.signal.addEventListener("abort", () => callback(new Error("cancelled"), ""), { once: true });
    });
    const controller = new AbortController();
    const pending = readSystemProxyAsync("darwin", controller.signal);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(signal?.aborted).toBe(false);
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it("uses the existing macOS parser", async () => {
    commands.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890");
    });
    await expect(readSystemProxyAsync("darwin")).resolves.toEqual({ https_proxy: "http://127.0.0.1:7890" });
  });

  it.each(["true", "false"])("uses the GNOME parser with use-same-proxy=%s", async (sameProxy) => {
    const settings: Record<string, string> = {
      "org.gnome.system.proxy:mode": "'manual'",
      "org.gnome.system.proxy:use-same-proxy": sameProxy,
      "org.gnome.system.proxy.http:host": "'127.0.0.1'",
      "org.gnome.system.proxy.http:port": "7890",
      "org.gnome.system.proxy.https:host": "'127.0.0.1'",
      "org.gnome.system.proxy.https:port": "7891",
      "org.gnome.system.proxy.socks:host": "''",
      "org.gnome.system.proxy.socks:port": "0",
      "org.gnome.system.proxy:ignore-hosts": "['localhost']",
    };
    commands.execFile.mockImplementation((_file, args, _options, callback) => {
      const value = settings[`${args[1]}:${args[2]}`];
      if (value === undefined) throw new Error("unexpected setting");
      callback(null, value);
    });
    await expect(readSystemProxyAsync("linux")).resolves.toEqual({
      http_proxy: "http://127.0.0.1:7890",
      https_proxy: sameProxy === "true" ? "http://127.0.0.1:7890" : "http://127.0.0.1:7891",
      no_proxy: "localhost",
    });
  });

  it("does not start a command after cancellation", async () => {
    commands.execFile.mockClear();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(readSystemProxyAsync("linux", controller.signal)).rejects.toThrow("stopped");
    expect(commands.execFile).not.toHaveBeenCalled();
  });
});
