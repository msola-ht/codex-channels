import type { HookCommandView, HookEntry } from "../application/index.js";

export interface HookCommandChoice {
  label: string;
  input: string;
}

const hookActionLabels = { trust: "信任", enable: "启用", disable: "停用" } as const;
const hookTrustLabels = {
  managed: "受管（只读）",
  untrusted: "未信任",
  trusted: "已信任",
  modified: "配置已变化，需重新审查",
} as const;

export function formatConversationHooks(view: HookCommandView): string {
  const lines = [
    `Hooks · 第 ${view.page}/${view.pageCount} 页`,
    `Workspace：${hookDisplayText(view.workspaceId)}`,
    `Provider：${hookDisplayText(view.provider)}`,
    `诊断：${view.warningCount} 项警告 · ${view.errorCount} 项错误`,
  ];
  if (view.updated) {
    if (view.refreshFailedProviders?.length) {
      lines.push(`该 Hook 的${hookActionLabels[view.updated]}设置已保存，刷新未确认。`,
        `未确认刷新的 Provider：${view.refreshFailedProviders.map(provider => hookDisplayText(provider)).join("、")}`,
        "请核对这些实例的连接与 Hook 状态；本次不会重复写入。");
    } else {
      lines.push(`已${hookActionLabels[view.updated]}该 Hook。`);
    }
  }
  if (view.detail) {
    const { hook } = view.detail;
    lines.push(
      "",
      `事件：${hookDisplayText(hook.eventName)}`,
      `匹配：${hook.matcher === null ? "全部" : hookDisplayText(hook.matcher)}`,
      `处理器：${hook.handlerType}`,
      `超时：${hook.timeoutSec} 秒`,
      `异步：${hook.async === null ? "不适用" : hook.async ? "是" : "否"}`,
      `附加上下文上限：${hook.additionalContextLimit === null ? "默认 2500 tokens" : hook.additionalContextLimit === 0 ? "关闭溢出" : `${hook.additionalContextLimit} tokens`}`,
      `${hook.handlerType === "command" ? "命令" : "处理目标"}：${hookDisplayText(hook.description) || "（无说明）"}`,
      `来源：${hookDisplayText(hook.source)}`,
      `配置路径：${hookDisplayText(hook.sourcePath)}`,
      `状态：${hook.enabled ? "启用" : "停用"} · ${hookTrustLabels[hook.trustStatus]}`,
    );
    if (!hook.isManaged && !hook.reviewable) {
      lines.push("当前 Hook 无法完整审查，不能在渠道中信任。请先在本机处理配置。");
    }
  } else {
    lines.push("", ...view.entries.map(({ selector, hook }) =>
      `${selector} · ${hookDisplayText(hook.eventName, 80)} · ${hook.handlerType} · ${hookDisplayText(hook.source, 80)} · ${hook.enabled ? "启用" : "停用"} · ${hookTrustLabels[hook.trustStatus]}`
    ));
    if (view.entries.length === 0) lines.push("当前页没有 Hook。");
  }
  lines.push(
    "",
    "信任及启停会持久修改共享 Codex 用户目录中的 Hook 配置，影响使用该配置的其他 Provider 实例与会话。",
    "信任只表示认可当前配置，不表示执行成功；配置哈希不覆盖脚本文件内容，修改脚本需另行审查。",
  );
  if (view.confirmation) {
    lines.push(
      "",
      `待确认：${hookActionLabels[view.confirmation.action]}该 Hook。`,
      "确认令牌五分钟内有效，仅可使用一次；配置或当前会话上下文变化后需重新预览。",
    );
  }
  lines.push("", ...hookCommandChoices(view).map(choice => `${choice.label}：/hooks ${choice.input}`));
  return lines.join("\n");
}

export function hookCommandChoices(view: HookCommandView): HookCommandChoice[] {
  if (view.updated) return [{ label: "刷新列表", input: `page ${view.page}` }];
  if (view.confirmation && view.detail) {
    return [
      { label: `确认${hookActionLabels[view.confirmation.action]}`, input: `confirm ${view.confirmation.token}` },
      { label: "返回详情", input: view.detail.selector },
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

/** Trust requires the platform's detail view to preserve every review field exactly. */
export function canReviewConversationHook(hook: HookEntry, preservesText: (value: string) => boolean): boolean {
  const fields = [hook.eventName, hook.matcher ?? "", hook.description, hook.source, hook.sourcePath];
  return fields.every(value => hookDisplayText(value) === value
    && preservesText(value));
}
