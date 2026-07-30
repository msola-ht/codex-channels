import type { ConversationTarget } from "../../conversation-core/index.js";

import type { WeixinCredentialStore } from "./credential-store.js";
import {
  renderWeixinPollingHealth,
  type WeixinPollingHealthSnapshot,
} from "./polling-health.js";
import type {
  WeixinReplyContextPersistence,
} from "./reply-context-persistence.js";
import type { WeixinUpdatesCursorStore } from "./updates-cursor-store.js";

export type WeixinDoctorRecordStatus =
  | "available"
  | "missing"
  | "unavailable";

export interface WeixinDoctorSnapshot {
  credential: WeixinDoctorRecordStatus;
  replyContext: WeixinDoctorRecordStatus;
  cursor: WeixinDoctorRecordStatus;
  polling: WeixinPollingHealthSnapshot;
}

export interface WeixinDoctor {
  inspect(target: ConversationTarget): Promise<WeixinDoctorSnapshot>;
}

export interface CreateWeixinDoctorOptions {
  accountId: string;
  credentialStore: Pick<WeixinCredentialStore, "get">;
  replyContextPersistence: Pick<WeixinReplyContextPersistence, "get">;
  cursorStore: Pick<WeixinUpdatesCursorStore, "get">;
  pollingHealth: { snapshot(): WeixinPollingHealthSnapshot };
}

export function createWeixinDoctor(
  options: CreateWeixinDoctorOptions,
): WeixinDoctor {
  return {
    async inspect(target) {
      if (
        target.surface !== "weixin"
        || target.accountId !== options.accountId
      ) {
        throw new Error("微信 Doctor 目标无效");
      }
      const [credential, replyContext, cursor] = await Promise.all([
        inspectRecord(() => options.credentialStore.get(options.accountId)),
        inspectRecord(() => options.replyContextPersistence.get(target)),
        inspectRecord(() => options.cursorStore.get(options.accountId)),
      ]);
      return {
        credential,
        replyContext,
        cursor,
        polling: options.pollingHealth.snapshot(),
      };
    },
  };
}

export function renderWeixinDoctor(
  snapshot: WeixinDoctorSnapshot,
  nowMs = Date.now(),
): string {
  return [
    "微信 Doctor",
    `Bot 凭据：${recordStatusLabel(snapshot.credential)}`,
    `回复上下文：${recordStatusLabel(snapshot.replyContext)}`,
    `后台游标：${recordStatusLabel(snapshot.cursor)}`,
    `Token 状态：${tokenStatusLabel(snapshot)}`,
    renderWeixinPollingHealth(snapshot.polling, nowMs),
  ].join("\n");
}

async function inspectRecord(
  read: () => Promise<unknown>,
): Promise<WeixinDoctorRecordStatus> {
  try {
    return await read() === null ? "missing" : "available";
  } catch {
    return "unavailable";
  }
}

function recordStatusLabel(status: WeixinDoctorRecordStatus): string {
  switch (status) {
    case "available":
      return "可用";
    case "missing":
      return "尚未建立";
    case "unavailable":
      return "不可用";
  }
}

function tokenStatusLabel(snapshot: WeixinDoctorSnapshot): string {
  if (snapshot.credential === "missing") {
    return "未配置";
  }
  if (snapshot.credential === "unavailable") {
    return "无法核验本地凭据";
  }
  return snapshot.polling.phase === "credential-pause"
    ? "已失效，请重新运行 codexc setup"
    : "后台未报告失效";
}
