import type { HookCommandView, HookEntry } from "../application/index.js";

export interface HookCommandChoice {
  label: string;
  input: string;
}

const hookActionLabels = { trust: "信任", enable: "启用", disable: "停用", "trust-all": "全部信任" } as const;
const hookTrustLabels = {
  managed: "受管（只读）",
  untrusted: "未信任",
  trusted: "已信任",
  modified: "已变更，待信任",
} as const;

export function formatConversationHooks(view: HookCommandView, queryOnly = false): string {
  const lines = [
    view.detail || view.bulkCount !== undefined || view.updated ? "Hooks" : `Hooks · ${view.page}/${view.pageCount}`,
    `工作区：${hookDisplayText(view.workspaceId)} · 提供商：${hookDisplayText(view.provider)}`,
  ];
  if (view.warningCount || view.errorCount) lines.push(`警告 ${view.warningCount} · 错误 ${view.errorCount}`);
  const subject = view.bulkCount === undefined ? "该 Hook" : `${view.bulkCount} 个 Hook`;
  if (view.updated) {
    if (view.refreshFailedProviders?.length) {
      lines.push(`已保存${subject}的${view.updated === "trust-all" ? "信任" : hookActionLabels[view.updated]}设置。`,
        `刷新未确认：${view.refreshFailedProviders.map(provider => hookDisplayText(provider)).join("、")}。请用 /hooks 核对，不会重复写入。`);
    } else {
      lines.push(`已${view.updated === "trust-all" ? "信任" : hookActionLabels[view.updated]}${subject}。`);
    }
  } else if (view.detail) {
    const { hook } = view.detail;
    lines.push(
      "",
      `事件：${hookDisplayText(hook.eventName)}`,
      `匹配：${hook.matcher === null ? "全部" : hookDisplayText(hook.matcher)}`,
      `处理器：${hook.handlerType} · 超时：${hook.timeoutSec} 秒 · 异步：${hook.async === null ? "不适用" : hook.async ? "是" : "否"}`,
      `附加上下文上限：${hook.additionalContextLimit === null ? "默认 2500 tokens" : hook.additionalContextLimit === 0 ? "关闭溢出" : `${hook.additionalContextLimit} tokens`}`,
      `${hook.handlerType === "command" ? "命令" : "处理目标"}：${hookDisplayText(hook.description) || "（无说明）"}`,
      `来源：${hookDisplayText(hook.source)}`,
      `配置路径：${hookDisplayText(hook.sourcePath)}`,
      `状态：${hook.enabled ? "启用" : "停用"} · ${hookTrustLabels[hook.trustStatus]}`,
    );
    if (!hook.isManaged && !hook.reviewable) {
      lines.push("无法完整展示，逐项信任请在本机审查；也可返回列表选择全部信任。");
    }
  } else if (view.bulkCount !== undefined) {
    lines.push("", `信任当前工作区全部 ${view.bulkCount} 个待审核 Hook（跨分页，不含受管项）。`,
      "不逐项审查，包括无法完整展示的项；保留启停状态。");
  } else {
    lines.push("", ...view.entries.map(({ selector, hook }) =>
      `${selector} · ${hookDisplayText(hook.eventName, 80)} · ${hook.handlerType} · ${hookDisplayText(hook.source, 80)} · ${hook.enabled ? "启用" : "停用"} · ${hookTrustLabels[hook.trustStatus]}`
    ));
    if (view.entries.length === 0) lines.push("当前页没有 Hook。");
  }
  if (view.confirmation) {
    lines.push(
      "",
      ...(view.confirmation.action === "trust-all" ? [] : [`确认${hookActionLabels[view.confirmation.action]}该 Hook？`]),
      "将持久保存，影响共用配置的提供商和会话。",
      ...(view.confirmation.action === "trust" || view.confirmation.action === "trust-all"
        ? ["仅信任当前定义，变更后需重新信任；不代表执行成功。"] : []),
      "确认码 5 分钟内有效，仅可用一次；配置或会话变化后失效。",
    );
  }
  lines.push("", ...(queryOnly ? [] : hookCommandChoices(view).map(choice => `${choice.label}：/hooks ${choice.input}`)));
  return lines.join("\n");
}

export function hookCommandChoices(view: HookCommandView): HookCommandChoice[] {
  if (view.updated) return [{ label: "刷新列表", input: `page ${view.page}` }];
  if (view.confirmation) {
    return [
      { label: `确认${hookActionLabels[view.confirmation.action]}`, input: `confirm ${view.confirmation.token}` },
      view.detail ? { label: "返回详情", input: view.detail.selector } : { label: "返回列表", input: "page 1" },
    ];
  }
  if (view.detail) {
    const { selector, hook } = view.detail;
    return [
      ...hookAllowedActions(hook).map(action => ({ label: hookActionLabels[action], input: `${action} ${selector}` })),
      { label: "返回列表", input: `page ${view.page}` },
    ];
  }
  return [
    ...view.entries.map(({ selector, hook }) => ({ label: `查看 ${hookDisplayText(hook.eventName, 32)}`, input: selector })),
    ...(view.page > 1 ? [{ label: "上一页", input: `page ${view.page - 1}` }] : []),
    ...(view.page < view.pageCount ? [{ label: "下一页", input: `page ${view.page + 1}` }] : []),
    { label: "全部信任", input: "trust all" },
    { label: "刷新", input: `page ${view.page}` },
  ];
}

function hookAllowedActions(hook: HookEntry): Array<"trust" | "enable" | "disable"> {
  if (hook.isManaged || hook.trustStatus === "managed") return [];
  if (hook.trustStatus === "trusted") return [hook.enabled ? "disable" : "enable"];
  return hook.reviewable ? ["trust"] : [];
}

function hookDisplayText(value: string, limit = 500): string {
  const characters = [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ")];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("");
}

/** Individual review requires the detail view to preserve every review field exactly. */
export function canReviewConversationHook(hook: HookEntry, preservesText: (value: string) => boolean): boolean {
  const fields = [hook.eventName, hook.matcher ?? "", hook.description, hook.source, hook.sourcePath];
  return fields.every(value => hookDisplayText(value) === value
    && preservesText(value));
}
