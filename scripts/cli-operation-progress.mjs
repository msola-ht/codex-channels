import { performance } from "node:perf_hooks";
import { ReportedChildExitError } from "../runtime/process-lifecycle.mjs";

/** Presentation only: callers must settle their work before returning on cancellation. */
export async function withCliProgress(label, operation) {
  const controller = new AbortController();
  const cancel = (signal) => controller.abort(Object.assign(
    new ReportedChildExitError(signal === "SIGINT" ? 130 : 143, `${label}已取消`), { name: "AbortError" },
  ));
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let spinner;
  let current = label;
  const startedAt = performance.now();
  const elapsed = () => `${((performance.now() - startedAt) / 1000).toFixed(2)} 秒`;
  try {
    if (process.stdout.isTTY && process.stderr.isTTY && !process.env.CI && process.env.TERM !== "dumb") {
      try {
        const prompts = await import("@clack/prompts");
        if (!prompts.isCI()) {
          spinner = prompts.spinner({ output: process.stdout, withGuide: false, cancelMessage: `${label}已取消，正在收尾` });
        }
      } catch {
        // Clean source installations may not have installed their dependencies yet.
      }
    }
    controller.signal.throwIfAborted();
    if (spinner) spinner.start(label);
    else process.stdout.write(`[进行中] ${label}\n`);
    const result = await operation({
      signal: controller.signal,
      interactive: Boolean(spinner),
      message(text) {
        current = text;
        if (!controller.signal.aborted) spinner?.message(text);
      },
      log(text, { stream = "stdout" } = {}) {
        if (!text) return;
        spinner?.clear();
        process[stream].write(text.endsWith("\n") ? text : `${text}\n`);
        if (spinner && !controller.signal.aborted) spinner.start(current);
      },
    });
    controller.signal.throwIfAborted();
    const message = `${label}：完成，耗时 ${elapsed()}。`;
    if (spinner) spinner.stop(message);
    else process.stdout.write(`[成功] ${message}\n`);
    return result;
  } catch (error) {
    const message = `${label}：${controller.signal.aborted ? "已取消" : "失败"}，耗时 ${elapsed()}。`;
    if (spinner) {
      spinner.error(message);
      if (controller.signal.aborted) process.stderr.write(`${message}\n`);
    } else process.stderr.write(`[失败] ${message}\n`);
    throw error;
  } finally {
    spinner?.clear();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
