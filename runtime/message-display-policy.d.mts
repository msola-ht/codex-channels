import type { ZodType } from "zod";
export type MessageDisplaySurface = "telegram" | "feishu" | "weixin" | "qq";
export type MessageDisplayTarget = { surface: MessageDisplaySurface; accountId: string; chatKind: "direct" | "group"; chatId: string };
export interface MessageDisplaySettings { operationUpdates: "full" | "detailed" | "compact" | "failures" | "hidden"; subagentsEnabled: boolean; streamingEnabled: boolean; commentaryEnabled: boolean; routineNotificationsEnabled: boolean; planUpdatesEnabled: boolean; reasoningEnabled: boolean; completion: "off" | "brief" | "detailed"; presentationDetail: "basic" | "detailed" | "full" }
export interface MessageDisplaySelector { surface: MessageDisplaySurface; account_id?: string; chat_kind?: "direct" | "group"; chat_id?: string }
export interface MessageDisplayOverride extends MessageDisplaySelector { operation_updates?: "full" | "detailed" | "compact" | "failures" | "hidden"; subagents?: boolean; streaming?: boolean; commentary?: boolean; routine_notifications?: boolean; plan_updates?: boolean; reasoning?: boolean; completion?: "off" | "brief" | "detailed"; presentation_detail?: "basic" | "detailed" | "full" }
export interface MessageDisplayConfiguration { operation_updates: "full" | "detailed" | "compact" | "failures" | "hidden"; subagents?: boolean; streaming?: boolean; commentary?: boolean; routine_notifications?: boolean; plan_updates: boolean; reasoning: boolean; completion?: "off" | "brief" | "detailed"; presentation_detail?: "basic" | "detailed" | "full"; overrides?: readonly MessageDisplayOverride[] }
export type MessageDisplaySource = "global" | "surface" | "account" | "chat-kind" | "chat";
export type MessageDisplayField = Exclude<keyof MessageDisplayOverride, keyof MessageDisplaySelector>;
export type MessageDisplayPreset = "concise" | "standard" | "detailed" | "full";
export const messageDisplayFields: readonly (readonly [MessageDisplayField, keyof MessageDisplaySettings])[];
export const messageDisplayPresets: Readonly<Record<MessageDisplayPreset, Readonly<Required<Pick<MessageDisplayOverride, MessageDisplayField>>>>>;
export function supportedMessageDisplayFields(selector?: MessageDisplaySelector): MessageDisplayField[];
export function identifyMessageDisplayPreset(settings: MessageDisplaySettings, supportedFields?: readonly MessageDisplayField[]): MessageDisplayPreset | "custom";
export const messageDisplayOverrideSchema: ZodType<MessageDisplayOverride>;
export const messageDisplayOverridesSchema: ZodType<MessageDisplayOverride[]>;
export function messageDisplaySelectorKey(value: MessageDisplaySelector): string;
export function inspectMessageDisplayScope(configuration: MessageDisplayConfiguration, selector?: MessageDisplaySelector): { settings: MessageDisplaySettings; sources: Record<keyof MessageDisplaySettings, MessageDisplaySource> };
export function inspectMessageDisplaySettings(configuration: MessageDisplayConfiguration, target: MessageDisplayTarget): { settings: MessageDisplaySettings; sources: Record<keyof MessageDisplaySettings, MessageDisplaySource> };
export function resolveMessageDisplaySettings(configuration: MessageDisplayConfiguration, target: MessageDisplayTarget): MessageDisplaySettings;
