import { parentPort } from "node:worker_threads";

let finished = false;
const controller = new AbortController();
// Keep ownership with the parent until its bounded termination path confirms exit.
parentPort.on("message", (message) => {
  if (message === "abort") controller.abort();
});

function send(message) {
  if (!finished) parentPort.postMessage(message);
}

function fail(code) {
  send({ type: "error", code });
  finished = true;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isString(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    && value.trim() === value && !/[\s\p{Cc}]/u.test(value);
}

function credentialsFrom(value) {
  if (!Array.isArray(value) || value.length !== 1 || !isPlainObject(value[0])) return undefined;
  const credentials = value[0];
  const descriptors = Object.getOwnPropertyDescriptors(credentials);
  if (Reflect.ownKeys(descriptors).length !== 3
    || !["appId", "appSecret", "userOpenid"].every((key) =>
      Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], "value"))) return undefined;
  const appId = descriptors.appId.value;
  const appSecret = descriptors.appSecret.value;
  const userOpenid = descriptors.userOpenid.value;
  if (!isString(appId, 256) || !isString(appSecret, 4_096) || !isString(userOpenid, 256)) return undefined;
  return { appId, appSecret, userOpenid };
}

function isQrUrl(value) {
  if (!isString(value, 4_096)) return false;
  const url = new URL(value);
  return url.origin === "https://q.qq.com" && !url.username && !url.password && !url.hash
    && url.pathname === "/qqbot/openclaw/connect.html"
    && isString(url.searchParams.get("task_id"), 1_024);
}

// Only the documented public export is used. The connector has no HTTP/Agent
// injection point; its direct HTTPS requests are stopped by parent termination.
let startQrConnect;
try {
  ({ startQrConnect } = await import("@tencent-connect/qqbot-connector"));
  if (typeof startQrConnect !== "function") throw new Error();
} catch {
  fail("sdk-unavailable");
}

if (!finished) {
  try {
    startQrConnect({
      onSuccess(value) {
        if (finished) return;
        try {
          const credentials = credentialsFrom(value);
          if (!credentials) {
            fail("invalid-result");
            return;
          }
          send({ type: "result", value: credentials });
          finished = true;
        } catch {
          fail("invalid-result");
        }
      },
      onFailure() { fail("registration-failed"); },
      onQrDisplayed(value) {
        if (finished) return;
        try {
          if (!isQrUrl(value)) {
            fail("invalid-result");
            return;
          }
          send({ type: "qr", value });
        } catch {
          fail("invalid-result");
        }
      },
      onQrExpired() { send({ type: "expired" }); },
    }, {
      displayQrCodeToConsole: false,
      signal: controller.signal,
    });
  } catch {
    fail("registration-failed");
  }
}
