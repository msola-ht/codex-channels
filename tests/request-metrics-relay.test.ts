import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteModelRequestMetricsStore, BufferedModelRequestMetricsWriter,
  type ModelRequestMetricSample } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const relay = (): ModelRequestMetricSample => ({ ...sample(), source: "relay", threadId: null, turnId: null,
  callerId: "caller-a", keyId: "key-a", credentialGeneration: 1, relayRequestId: "47d8c4b4-03af-457e-857e-7ab710d55163", deliveryStatus: "finished" });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-metrics-")); roots.push(root);
  const path = join(root, "metrics.sqlite3");
  return { path, root };
}
describe("Relay metrics storage", () => {
  it.each([20, 21, 22, 23, 24, 25, 26])("rejects schema %s without changing its bytes", version => {
    const { path } = fixture();
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_metadata VALUES ('schema_version', ${version});`);
    database.close();
    const before = readFileSync(path);
    expect(() => new SqliteModelRequestMetricsStore(path, undefined, { readOnly: true })).toThrow("仅支持当前 Schema");
    expect(readFileSync(path)).toEqual(before);
  });
  it("deduplicates only Relay IDs without losing owned rows in the same batch", () => {
    const { path } = fixture();
    const store = new SqliteModelRequestMetricsStore(path);
    try {
      store.recordBatch([relay(), { ...relay(), inputTokens: 9999 }, sample()]);
      expect(store.count()).toBe(2);
      const rows = store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, source: "relay", callerId: "caller-a", limit: 10 });
      expect(rows.records).toHaveLength(1); expect(rows.records[0]).toMatchObject({ inputTokens: 1000, threadId: null, callerId: "caller-a" });
      expect(() => store.record({ ...relay(), relayRequestId: "57d8c4b4-03af-457e-857e-7ab710d55163", threadId: "forged" })).toThrow();
      expect(() => store.record({ ...sample(), callerId: "forged" })).toThrow();
      expect(() => store.record({ ...relay(), relayRequestId: "not-a-uuid" })).toThrow("请求 ID");
    } finally { store.close(); }
  });
  it("keeps capacity for owned metrics when Relay fills its share", async () => {
    const written: ModelRequestMetricSample[] = [];
    const writer = new BufferedModelRequestMetricsWriter({ record: value => { written.push(value); }, close: () => {}, recordSubagentThread: () => {}, recordSubagentTurn: () => {} });
    for (let index = 0; index < 256; index++) writer.enqueue(relay());
    expect(() => writer.enqueue(relay())).toThrow("Relay");
    writer.enqueue(sample()); await writer.close();
    expect(written).toHaveLength(257); expect(written.at(-1)?.source).toBeUndefined();
  });
});
