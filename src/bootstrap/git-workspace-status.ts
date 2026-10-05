import { execFile } from "node:child_process";

/** 只读取已授权 Workspace 的分支；可选展示失败时省略，有界且可取消。 */
export function currentGitBranch(projectRoot: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const cancel = () => { child.kill("SIGKILL"); };
    const child = execFile("git", ["-C", projectRoot, "branch", "--show-current"], {
      encoding: "utf8",
      maxBuffer: 4_096,
      timeout: 2_000,
      killSignal: "SIGKILL",
    }, (error, stdout) => {
      signal?.removeEventListener("abort", cancel);
      if (error || signal?.aborted) { resolve(undefined); return; }
      const branch = stdout.trim();
      resolve(branch && Buffer.byteLength(branch, "utf8") <= 512 ? branch : undefined);
    });
    // execFile's built-in AbortSignal uses SIGTERM even when killSignal is set.
    // A display query must also terminate children that ignore graceful shutdown.
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
