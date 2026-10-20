import { SingleWorkerReader } from "./single-worker-reader.mjs";

/** Only fingerprints and safe status return to the settings observer. */
export class ProviderSettingsSnapshotReader {
  #reader;
  constructor(environment, aggregateMembers = []) {
    this.environment = { ...environment };
    this.aggregateMembers = [...aggregateMembers];
    this.#reader = new SingleWorkerReader({
      workerUrl: new URL("./provider-settings-snapshot-worker.mjs", import.meta.url),
      workerData: () => ({ environment: this.environment, aggregateMembers: this.aggregateMembers }),
      readTimeoutMs: () => 2_000,
      errors: {
        unavailable: () => new Error("Provider settings reader unavailable"),
        failure: phase => Object.assign(new Error("Provider settings snapshot unavailable"), {
          phase, reason: "worker-unavailable",
        }),
        invalid: result => Object.assign(new Error("Provider settings snapshot rejected"), {
          phase: result?.phase === "validation" ? "validation" : "read", reason: "snapshot-invalid",
        }),
        shutdown: () => new Error("Provider settings worker shutdown unconfirmed"),
      },
    });
  }
  read() { return this.#reader.read(); }
  readFresh() { return this.#reader.readFresh(); }
  close() { return this.#reader.close(); }
  waitForExit() { return this.#reader.waitForExit(); }
}
