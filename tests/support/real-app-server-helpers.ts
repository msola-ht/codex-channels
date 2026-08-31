import type { ChildProcess } from "node:child_process";

export async function waitFor(predicate: () => boolean, timeoutMs: number, failure?: () => Error | undefined): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    const currentFailure = failure?.();
    if (currentFailure) throw currentFailure;
    if (Date.now() - started > timeoutMs) throw new Error("等待 Codex App Server Unix Socket 超时；请检查 App Server stderr");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
export function signalTestProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try { process.kill(-child.pid, signal); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    return;
  }
  child.kill(signal);
}
export async function stopDetachedTestProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalTestProcessTree(child, "SIGTERM");
  try { await waitFor(() => child.exitCode !== null || child.signalCode !== null, timeoutMs); }
  catch (error) { signalTestProcessTree(child, "SIGKILL"); await waitFor(() => child.exitCode !== null || child.signalCode !== null, 2_000); throw error; }
}
export function appendDiagnostic(current: string, chunk: string): string { return `${current}${chunk}`.slice(-4_000); }
export function appServerFailure(message: string, stderr: string): string {
  const sanitized = stderr.replace(/(authorization|token|password|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]").trim();
  return sanitized ? `${message}\nApp Server stderr:\n${sanitized}` : message;
}
