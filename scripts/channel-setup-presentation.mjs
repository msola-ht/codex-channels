import * as prompts from "@clack/prompts";
import qrcode from "qrcode";

export class ChannelSetupCancelled extends Error {}

export function createChannelPrompter(input, output) {
  const read = async (operation, options) => {
    options?.signal?.throwIfAborted();
    const value = await operation({ input, output, ...options });
    options?.signal?.throwIfAborted();
    if (prompts.isCancel(value)) throw new ChannelSetupCancelled();
    return typeof value === "string" ? value.trim() : value;
  };
  return {
    ask: (message, options) => read(prompts.text, { ...options, message }),
    secret: (message, options) => read(prompts.password, { ...options, message }),
    confirm: (message, initialValue, options) => read(prompts.confirm, {
      ...options, message, initialValue, active: "是", inactive: "否",
    }),
    select: (message, options) => read(prompts.select, {
      message, options, showInstructions: false,
    }),
    close: () => {},
  };
}

export function renderTerminalQRCode(value, output) {
  // 屏幕扫码无需印刷场景的高纠错冗余；保留完整模块，不缩放或裁剪。
  const options = { type: "terminal", small: true, errorCorrectionLevel: "L" };
  let width;
  let rendered;
  let renderFailed = false;
  try {
    width = qrcode.create(value, options).modules.size + 2;
    // qrcode 的终端 renderer 在回调前同步完成编码与渲染。
    qrcode.toString(value, options, (error, result) => {
      renderFailed = Boolean(error);
      rendered = result;
    });
  } catch {
    renderFailed = true;
  }
  if (renderFailed || typeof rendered !== "string") {
    throw new Error("二维码渲染失败，本次扫码已取消，请重新进入渠道接入向导。");
  }
  if (output.columns && width >= output.columns) {
    throw new Error(`终端过窄，二维码需要至少 ${width + 1} 列；本次扫码已取消，请加宽终端后重新接入。`);
  }
  output.write(`${rendered}\n`);
}
