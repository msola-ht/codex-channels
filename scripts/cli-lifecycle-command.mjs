import { spawn } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { ReportedChildExitError } from "../runtime/process-lifecycle.mjs";

// Update/uninstall must finish their own recovery, including after their launcher
// receives a signal. IPC avoids Windows kill(), which terminates rather than cancels.
export async function runCliLifecycleCommand(script, args, { environment, cwd, signal, stdout = "inherit" }) {
  signal?.throwIfAborted();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], {
    env: environment, cwd, stdio: ["inherit", stdout, "inherit", "ipc"],
    detached: true, windowsHide: true,
  });
  let ready = false;
  let requested;
  let sent = false;
  let failure;
  let deliveryError;
  const forward = () => {
    if (!ready || !requested || sent || !child.connected) return;
    sent = true;
    try {
      child.send({ type: "codexc-lifecycle-cancel", signal: requested }, error => {
        if (error) deliveryError = error;
      });
    } catch (error) { deliveryError = error; }
  };
  const cancel = signal => { requested ??= signal; forward(); };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  const abort = () => cancel(signal.reason?.exitCode === 130 ? "SIGINT" : "SIGTERM");
  const message = value => {
    if (value?.type !== "codexc-lifecycle-ready") return;
    ready = true;
    forward();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.on("message", message);
  try {
    const result = await new Promise(resolve => {
      child.once("error", error => { failure = error; });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (failure) throw failure;
    if (result.signal) throw new Error(`命令被信号终止，操作结果未确认：${result.signal}`);
    if (result.code !== 0) throw new ReportedChildExitError(result.code ?? 1);
    if (requested) {
      process.stderr.write(deliveryError
        ? "[提示] 取消请求传递未确认；子命令已结束，请核对上述操作结果。\n"
        : "[提示] 已收到取消请求；子命令已结束，请核对上述操作结果。\n");
      throw new ReportedChildExitError(requested === "SIGINT" ? 130 : 143);
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    signal?.removeEventListener("abort", abort);
    child.off("message", message);
  }
}

// The operation chooses safe boundaries for observing this signal. In-flight
// database writes and upstream archive requests must settle before it returns.
export async function withCliLifecycleCancellation(label, operation) {
  const controller = new AbortController();
  const cancel = signal => controller.abort(Object.assign(new Error(`${label}已取消，当前操作已收尾`), {
    name: "AbortError", exitCode: signal === "SIGINT" ? 130 : 143,
  }));
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const cleanup = installCliLifecycleCancellation(cancel);
  try {
    // Receive a cancellation already queued by the launcher before starting
    // synchronous work, and drain it again after that work has released locks.
    await setImmediate();
    controller.signal.throwIfAborted();
    const result = await operation(controller.signal);
    await setImmediate();
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      const failure = error instanceof Error ? error : new Error(String(error), { cause: error });
      failure.exitCode = controller.signal.reason.exitCode;
      throw failure;
    }
    throw error;
  } finally {
    cleanup();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

export function installCliLifecycleCancellation(cancel) {
  if (!process.send) return () => {};
  const message = value => {
    if (value?.type === "codexc-lifecycle-cancel" && ["SIGINT", "SIGTERM"].includes(value.signal)) cancel(value.signal);
  };
  const disconnect = () => cancel("SIGTERM");
  process.on("message", message);
  process.on("disconnect", disconnect);
  if (process.connected) process.send({ type: "codexc-lifecycle-ready" }, error => {
    if (error) disconnect();
  });
  else disconnect();
  return () => {
    process.off("message", message);
    process.off("disconnect", disconnect);
    if (process.connected) process.disconnect();
  };
}
