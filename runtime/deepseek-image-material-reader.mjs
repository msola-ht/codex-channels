import { SingleWorkerReader } from "./single-worker-reader.mjs";

/** Fresh managed DS material reads retain their Worker until physical exit. */
export class DeepseekImageMaterialReader {
  #reader;
  constructor(provider, environment) {
    if (typeof provider !== "string" || !/^ds-[a-z0-9_-]{1,32}$/u.test(provider)) {
      throw new Error("DeepSeek image provider invalid");
    }
    this.#reader = new SingleWorkerReader({
      workerUrl: new URL("./deepseek-image-material-worker.mjs", import.meta.url),
      workerData: () => ({ provider, environment }),
      readTimeoutMs: () => 2_000,
      errors: {
        unavailable: () => new Error("DeepSeek image material reader unavailable"),
        failure: () => new Error("DeepSeek image materials unavailable"),
        invalid: () => new Error("DeepSeek image materials invalid"),
        shutdown: () => new Error("DeepSeek image material worker shutdown unconfirmed"),
      },
    });
  }
  readFresh() { return this.#reader.readFresh(); }
  close() { return this.#reader.close(); }
  waitForExit() { return this.#reader.waitForExit(); }
}
