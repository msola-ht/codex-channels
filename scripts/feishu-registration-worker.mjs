import { parentPort, workerData } from "node:worker_threads";

import { defaultHttpInstance, registerApp } from "@larksuiteoapi/node-sdk";

const controller = new AbortController();
// Keep the worker owned until its async SDK workflow settles or is terminated.
parentPort.on("message", (message) => {
  if (message === "abort") controller.abort();
});
// This instance lives only in this worker; both begin and poll use these defaults.
defaultHttpInstance.defaults.timeout = 10_000;
defaultHttpInstance.defaults.signal = controller.signal;
defaultHttpInstance.interceptors.request.use((request) => {
  request.signal = globalThis.AbortSignal.any([
    controller.signal,
    globalThis.AbortSignal.timeout(10_000),
  ]);
  return request;
}, undefined, { synchronous: true });

try {
  const result = await registerApp({
    source: workerData.source,
    addons: workerData.addons,
    signal: controller.signal,
    onQRCodeReady: (value) => parentPort.postMessage({ type: "qr", value }),
    onStatusChange: (value) => parentPort.postMessage({ type: "status", value }),
  });
  parentPort.postMessage({ type: "result", value: result });
} catch (error) {
  const code = ["access_denied", "expired_token", "abort"].includes(error?.code)
    ? error.code
    : "registration-failed";
  parentPort.postMessage({ type: "error", code });
} finally {
  controller.abort();
  parentPort.close();
}
