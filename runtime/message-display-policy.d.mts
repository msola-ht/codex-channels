import type { ZodType } from "zod";
export type MessageDisplaySurface = "telegram" | "feishu" | "weixin" | "qq";
export type MessageDisplayTarget = { surface: MessageDisplaySurface; accountId: string; chatKind: "direct" | "group"; chatId: string };
export interface MessageDisplaySettings { operationUpdates: "full" | "compact" | "failures" | "hidden"; subagentsEnabled: boolean; streamingEnabled: boolean; planUpdatesEnabled: boolean; reasoningEnabled: boolean; completion: "off" | "brief" | "detailed"; presentationDetail: "basic" | "detailed" }
export interface MessageDisplaySelector { surface: MessageDisplaySurface; account_id?: string; chat_kind?: "direct" | "group"; chat_id?: string }
export interface MessageDisplayOverride extends MessageDisplaySelector { operation_updates?: "full" | "compact" | "failures" | "hidden"; subagents?: boolean; streaming?: boolean; plan_updates?: boolean; reasoning?: boolean; completion?: "off" | "brief" | "detailed"; presentation_detail?: "basic" | "detailed" }
export interface MessageDisplayConfiguration { operation_updates: "full" | "compact" | "failures" | "hidden"; subagents?: boolean; streaming?: boolean; plan_updates: boolean; reasoning: boolean; completion?: "off" | "brief" | "detailed"; presentation_detail?: "basic" | "detailed"; overrides?: readonly MessageDisplayOverride[] }
export type MessageDisplaySource = "global" | "surface" | "account" | "chat-kind" | "chat";
export const messageDisplayOverrideSchema: ZodType<MessageDisplayOverride>;
export const messageDisplayOverridesSchema: ZodType<MessageDisplayOverride[]>;
export function messageDisplaySelectorKey(value: MessageDisplaySelector): string;
export function inspectMessageDisplayScope(configuration: MessageDisplayConfiguration, selector?: MessageDisplaySelector): { settings: MessageDisplaySettings; sources: Record<keyof MessageDisplaySettings, MessageDisplaySource> };
export function inspectMessageDisplaySettings(configuration: MessageDisplayConfiguration, target: MessageDisplayTarget): { settings: MessageDisplaySettings; sources: Record<keyof MessageDisplaySettings, MessageDisplaySource> };
export function resolveMessageDisplaySettings(configuration: MessageDisplayConfiguration, target: MessageDisplayTarget): MessageDisplaySettings;
