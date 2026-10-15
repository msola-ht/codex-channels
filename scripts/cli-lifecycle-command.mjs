import { spawn } from "node:child_process";
import { ReportedChildExitError } from "../runtime/process-lifecycle.mjs";

// Update/uninstall must finish their own recovery, including after their launcher
// receives a signal. IPC avoids Windows kill(), which terminates rather than cancels.
export async function runCliLifecycleCommand(script, args, { environment, cwd }) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], {
    env: environment, cwd, stdio: ["inherit", "inherit", "inherit", "ipc"],
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
    child.send({ type: "codexc-lifecycle-cancel", signal: requested }, error => {
      if (error) deliveryError = error;
    });
  };
  const cancel = signal => { requested ??= signal; forward(); };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  const message = value => {
    if (value?.type !== "codexc-lifecycle-ready") return;
    ready = true;
    forward();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
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
    child.off("message", message);
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
