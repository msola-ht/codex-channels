import type { Api } from "grammy";

type TelegramAbortSignal = NonNullable<Parameters<Api["getUpdates"]>[1]>;

/**
 * grammY 的 Node 声明仍使用 abort-controller 的 Signal 类型，运行时接受原生 Signal。
 * 仅在 SDK 边界适配类型并保留对象身份；不能使用 never 隐藏参数位置错误。
 */
export function telegramAbortSignal(signal: AbortSignal): TelegramAbortSignal {
  return signal as unknown as TelegramAbortSignal;
}
