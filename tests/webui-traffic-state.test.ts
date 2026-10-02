import { describe, expect, it } from "vitest";
import { canReuseTrafficSummary, resolveTrafficData, resolveTrafficDetailSnapshot, trafficCallKey, trafficDetailPath } from "../webui/src/lib/traffic-state.js";
import { modelNameComparison } from "../runtime/model-name-comparison.mjs";

describe("traffic request ownership", () => {
  it("loads only summaries for a list and performs no supplemental diagnostic requests", () => {
    const script = String.raw`
      import fs from "node:fs";
      import ts from "typescript";
      import assert from "node:assert/strict";
      const source = fs.readFileSync("webui/src/hooks/use-traffic.ts", "utf8")
        .replace(/^import .*$/gm, "").replace(/export function/g, "function");
      const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      const loaders = [], calls = [];
      const useApi = loader => { loaders.push(loader); return {data:null}; };
      const fetchList = async (query, signal) => { calls.push({query,signal}); return {exchanges:[]}; };
      const factory = new Function("useApi", "resolveTrafficData", "fetchTrafficExchanges", compiled + ";return useTrafficExchanges;");
      const hook = factory(useApi, () => null, fetchList);
      hook({limit:50});
      assert.equal(loaders.length, 1);
      const signal = new AbortController().signal;
      await loaders[0](signal);
      assert.deepEqual(calls, [{query:{limit:50},signal}]);
      hook(null);
      await loaders[1](signal);
      assert.equal(calls.length, 1);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).not.toThrow();
  });
  it("reuses only terminal summaries for lightweight trace pagination", () => {
    expect(canReuseTrafficSummary({ state: "pending", response: null })).toBe(false);
    expect(canReuseTrafficSummary({ state: "pending", response: {} })).toBe(false);
    for (const state of ["completed", "failed", "incomplete"]) {
      expect(canReuseTrafficSummary({ state, response: {} })).toBe(true);
      expect(canReuseTrafficSummary({ state, response: null })).toBe(false);
    }
    const call = { label: "openai", session: "batch-1", id: 1 };
    expect(trafficCallKey(call)).not.toBe(trafficCallKey({ ...call, label: "deepseek" }));
    expect(trafficCallKey(call)).not.toBe(trafficCallKey({ ...call, session: "batch-2" }));
  });
  it("retains only an explicitly identified call while its trace page changes", () => {
    const value = { label: "openai", session: "batch-1", exchange: { id: 7 } };
    const query = { label: "openai", session: "batch-1", id: 7 };
    expect(resolveTrafficDetailSnapshot(query, value)).toBe(value);
    for (const other of [null, { id: 7 }, { ...query, label: "deepseek" }, { ...query, session: "batch-2" }, { ...query, id: 8 }]) {
      expect(resolveTrafficDetailSnapshot(other, value)).toBeNull();
    }
    expect(resolveTrafficDetailSnapshot(query, null)).toBeNull();
  });
  it.each([
    ["model-a", "model-a", "名称一致"],
    [" model-a ", "model-a", "名称一致"],
    ["model-a", "model-b", "名称不一致"],
    ["model-a", "MODEL-A", "名称不一致"],
    ["model-a", "model-a-latest", "名称不一致"],
    ["model-a", null, "信息不足"],
    [undefined, "model-a", "信息不足"],
    ["", "model-a", "信息不足"],
  ])("compares only provided names: %s / %s", (request, response, expected) => {
    expect(modelNameComparison(request, response)).toBe(expected);
  });
  it("links to the recorded label, session and interaction without using the current selection", () => {
    expect(trafficDetailPath({ label: "ocg", session: "2026-09-19T00-00-00-000Z-2", interaction: 23 }))
      .toBe("/traffic?label=ocg&exchangeSession=2026-09-19T00-00-00-000Z-2&id=23");
  });
  it("does not expose the previous provider while a new label or latest session is loading", () => {
    const oldQuery = { label: "openai", session: "old", limit: 50, offset: 0 };
    const data = { key: JSON.stringify(oldQuery), value: { label: "openai", session: "old" } };
    for (const query of [{ label: "ocg" }, { label: "deepseek" }, {}]) {
      expect(resolveTrafficData(JSON.stringify(query), data)).toBeNull();
    }
    expect(resolveTrafficData(JSON.stringify(oldQuery), data)).toEqual({ label: "openai", session: "old" });
  });

  it("does not expose a previous detail across provider, session, id or trace page changes", () => {
    const query = { label: "ocg", session: "current", id: 1, traceOffset: 0 };
    const data = { key: JSON.stringify(query), value: { label: "ocg", session: "current" } };
    for (const change of [{ label: "deepseek" }, { session: "next" }, { id: 2 }, { traceOffset: 100 }]) {
      expect(resolveTrafficData(JSON.stringify({ ...query, ...change }), data)).toBeNull();
    }
    expect(resolveTrafficData("null", data)).toBeNull();
    expect(resolveTrafficData(JSON.stringify(query), null)).toBeNull();
    expect(resolveTrafficData(JSON.stringify(query), data)).toEqual({ label: "ocg", session: "current" });
  });
});
import { execFileSync } from "node:child_process";
