import { performance } from "node:perf_hooks";
import { clearLine, cursorTo } from "node:readline";
import { ReportedChildExitError } from "../runtime/process-lifecycle.mjs";

export function writeCliSection(title) {
  const line = process.env.TERM === "dumb" ? "---" : "──";
  process.stdout.write(`\n${line} ${title} ${line}\n`);
}

// Clack's spinner takes stdin into raw mode and exits immediately on Ctrl+C.
// Progress must leave input and cancellation ownership with the operation.
function createProgressSpinner(output) {
  let timer;
  let text = "";
  let frame = 0;
  const clear = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    cursorTo(output, 0);
    clearLine(output, 0);
  };
  const finish = message => { clear(); output.write(`${message}\n`); };
  return {
    start(message) {
      clear();
      text = message;
      timer = setInterval(() => {
        cursorTo(output, 0);
        clearLine(output, 0);
        const line = `${["◒", "◐", "◓", "◑"][frame++ % 4]} ${text.replace(/[\r\n]/g, " ")}`;
        // Leave room for double-width text and avoid wrapping the animated line.
        output.write(Array.from(line).slice(0, Math.max(1, Math.floor(((output.columns || 80) - 1) / 2))).join(""));
      }, 100);
    },
    message(message) { text = message; },
    clear,
    stop: finish,
    cancel: finish,
    error: finish,
  };
}

/** Presentation only: callers must settle their work before returning on cancellation. */
export async function withCliProgress(label, operation, {
  output = process.stdout, delayMs = 0, signal, handleSignals = true,
} = {}) {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("进度显示延迟必须是非负数");
  const controller = new AbortController();
  const cancel = (signal) => controller.abort(Object.assign(
    new ReportedChildExitError(signal === "SIGINT" ? 130 : 143, `${label}已取消`), { name: "AbortError" },
  ));
  let spinner;
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  const abort = () => controller.abort(signal.reason);
  if (handleSignals) {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
  }
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let current = label;
  let shown = false;
  let timer;
  const start = () => {
    if (!output || controller.signal.aborted) return;
    shown = true;
    if (spinner) spinner.start(current);
    else output.write(`[进行中] ${current}\n`);
  };
  const failureOutput = output === process.stdout ? process.stderr : output;
  const startedAt = performance.now();
  const elapsed = () => `${((performance.now() - startedAt) / 1000).toFixed(2)} 秒`;
  try {
    if (output?.isTTY && !process.env.CI && process.env.TERM !== "dumb") {
      spinner = createProgressSpinner(output);
    }
    controller.signal.throwIfAborted();
    if (delayMs === 0) start();
    else timer = setTimeout(start, delayMs);
    const result = await operation({
      signal: controller.signal,
      interactive: Boolean(spinner),
      message(text) {
        current = text;
        if (!controller.signal.aborted) spinner?.message(text);
      },
      log(text, { stream } = {}) {
        if (!text) return;
        spinner?.clear();
        const destination = stream === undefined ? output : process[stream];
        destination?.write(text.endsWith("\n") ? text : `${text}\n`);
        if (spinner && shown && !controller.signal.aborted) spinner.start(current);
      },
    });
    controller.signal.throwIfAborted();
    const message = `${label}：完成，耗时 ${elapsed()}。`;
    clearTimeout(timer);
    if (shown) {
      if (spinner) spinner.stop(message);
      else output?.write(`[成功] ${message}\n`);
    }
    return result;
  } catch (error) {
    const cancelled = controller.signal.aborted || error?.exitCode === 130 || error?.exitCode === 143;
    const message = `${label}：${cancelled ? "已取消" : "失败"}，耗时 ${elapsed()}。`;
    clearTimeout(timer);
    if (spinner && shown) {
      if (cancelled) spinner.cancel(message);
      else spinner.error(message);
    } else failureOutput?.write(`[失败] ${message}\n`);
    throw error;
  } finally {
    spinner?.clear();
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
