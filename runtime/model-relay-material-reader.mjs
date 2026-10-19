import { SingleWorkerReader } from "./single-worker-reader.mjs";

/** Provider and metrics reads keep separate budgets and material contracts. */
export class ModelRelayMaterialReader {
  #reader;
  constructor(configPath, environment, purpose = "provider") {
    this.configPath = configPath;
    this.environment = environment;
    this.purpose = purpose;
    this.#reader = new SingleWorkerReader({
      workerUrl: new URL("./model-relay-material-worker.mjs", import.meta.url),
      workerData: () => ({ configPath: this.configPath, environment: this.environment, purpose: this.purpose }),
      readTimeoutMs: () => this.purpose === "metrics" ? 750 : 2_000,
      errors: {
        unavailable: () => new Error("Relay material reader unavailable"),
        failure: () => new Error("Relay materials unavailable"),
        invalid: () => new Error("Relay materials invalid"),
        shutdown: () => new Error("Relay material worker shutdown unconfirmed"),
      },
    });
  }
  read() { return this.#reader.read(); }
  close() { return this.#reader.close(); }
}
