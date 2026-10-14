import { confirm, isCancel } from "@clack/prompts";

export function createPrompter(input, output) {
  let closed = false;
  let activeController;

  async function prompt(label, defaultValue, options = {}) {
    if (closed) throw abortError();
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    if (!input.isTTY || !output.isTTY) {
      throw new Error("交互输入需要本机终端；非交互调用请使用命令的显式参数");
    }
    if (activeController) throw new Error("终端问题尚未完成，不能同时发起其他交互输入");
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    activeController = controller;
    try {
      const value = await confirm({
        message: label,
        active: "是",
        inactive: "否",
        initialValue: defaultValue,
        input,
        output,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      return !isCancel(value) && value === true;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      activeController = undefined;
    }
  }

  return {
    confirm: (label, defaultValue = false, options) => prompt(label, defaultValue, options),
    close: () => {
      closed = true;
      activeController?.abort();
    },
  };
}

function abortError(reason) {
  const error = new Error("终端交互已取消", { cause: reason });
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}
