import type { Api } from "grammy";

export function replyOptions(
  replyTo?: number,
  silent = false,
): Parameters<Api["sendMessage"]>[2] {
  return {
    ...(silent ? { disable_notification: true } : {}),
    ...(replyTo === undefined
      ? {}
      : {
          reply_parameters: {
            message_id: replyTo,
            allow_sending_without_reply: true,
          },
        }),
  };
}

export function htmlSendOptions(
  replyTo?: number,
  silent = false,
): Parameters<Api["sendMessage"]>[2] {
  return {
    ...replyOptions(replyTo, silent),
    parse_mode: "HTML",
  };
}

export function operationEditOptions(): Parameters<Api["editMessageText"]>[3] {
  return { parse_mode: "HTML" };
}
