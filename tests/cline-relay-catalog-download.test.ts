import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import * as https from "node:https";
import { downloadClineRelayCatalog } from "../scripts/cline-relay-catalog.mjs";

vi.mock("node:https", () => ({ request: vi.fn() }));
vi.mock("../runtime/codex-proxy-env.mjs", () => ({ readCodexProxySettings: () => ({}) }));
vi.mock("../runtime/network-proxy.mjs", () => ({ createRefreshableHttpProxySelector: () => ({ select: async () => undefined, close: async () => {} }) }));
afterEach(() => vi.clearAllMocks());
function responses(values: Array<{ status: number; body: string }>) {
  const received: Array<{ url: string; options: { headers: Record<string, string> }; response: PassThrough }> = [];
  vi.mocked(https.request).mockImplementation(((url: string, options: { headers: Record<string, string> }, callback: (value: PassThrough & { statusCode: number }) => void) => {
    const value = values.shift(); if (!value) throw new Error("unexpected request");
    const response = Object.assign(new PassThrough(), { statusCode: value.status });
    received.push({ url, options, response });
    return Object.assign(new EventEmitter(), { end() {
      callback(response);
      if (!response.destroyed) response.end(value.body);
    } });
  }) as unknown as typeof https.request);
  return received;
}
it("pins the downloaded model file to the fetched commit without sending account credentials", async () => {
  const commit = "a".repeat(40);
  const received = responses([
    { status: 200, body: JSON.stringify({ sha: commit }) },
    { status: 200, body: 'export const models = {\n  providers: {"cline-pass":{"cline-pass/test":{"id":"cline-pass/test"}}}\n}\n' },
  ]);
  const result = await downloadClineRelayCatalog({});
  expect(result.commit).toBe(commit);
  expect(result.models).toEqual([{ id: "cline-pass/test" }]);
  expect(received[1]?.url).toContain(`/${commit}/sdk/packages/llms/src/catalog/catalog.generated.ts`);
  expect(received.every(entry => !Object.keys(entry.options.headers).some(key => /authorization|cookie/iu.test(key)))).toBe(true);
});
it.each([302, 403, 500])("closes HTTP %s immediately without following redirects or draining its body", async status => {
  const received = responses([{ status, body: "upstream body must not be consumed" }]);
  await expect(downloadClineRelayCatalog({})).rejects.toThrow("下载失败");
  expect(received).toHaveLength(1);
  expect(received[0]?.response.destroyed).toBe(true);
});
