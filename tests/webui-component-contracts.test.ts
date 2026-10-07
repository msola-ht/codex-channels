import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

describe("WebUI component interaction contracts", () => {
  let result: Record<string, string>;

  beforeAll(() => {
    // 保留真实组件与草稿逻辑；SSR 夹具只保存局部 state、捕获事件供重复渲染。
    const script = String.raw`
      import { createServer } from "vite";
      import { createElement as h } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { MemoryRouter } from "react-router";
      const stateHook = " function useState(initial) { const index = globalThis.fixtureStateCursor++; const state = globalThis.fixtureState; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; }";
      const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent", plugins: [{
        name: "component-event-fixture", enforce: "pre", transform(code, id) {
          if (["/src/components/settings/tool-access-settings.tsx", "/src/components/settings/app-server-settings-card.tsx", "/src/hooks/use-settings-draft.ts"].some(path => id.endsWith(path))) {
            return code.replace("useState } from", "useState as realUseState } from") + stateHook;
          }
          if (id.endsWith("/src/components/ui/button.tsx")) return code.replace("function Button({", "function RealButton({") + " import { createElement as fixtureElement } from 'react'; function Button(props) { globalThis.fixtureButtons.push(props); return fixtureElement(RealButton, props); }";
          if (id.endsWith("/src/components/settings/settings-controls.tsx")) return code.replace("export function ManagedSelect(", "function FixtureManagedSelect(") + " import { createElement as fixtureSelectElement } from 'react'; export function ManagedSelect(props) { globalThis.fixtureSelects.push(props); return fixtureSelectElement(FixtureManagedSelect, props); }";
          if (id.endsWith("/src/components/ui/input.tsx")) return code.replace("function Input({", "function RealInput({") + " function Input(props) { globalThis.fixtureInputs[props.id] = props; return React.createElement(RealInput, props); }";
          if (id.endsWith("/src/components/ui/sheet.tsx")) return code.replace("function SheetContent({", "function RealSheetContent({") + " function SheetContent(props) { globalThis.fixtureSheetContent = props; return React.createElement(RealSheetContent, props); }";
        },
      }] });
      try {
        const { LanguageContext } = await server.ssrLoadModule("/src/hooks/language-context.ts");
        const { TooltipProvider } = await server.ssrLoadModule("/src/components/ui/tooltip.tsx");
        const { Tabs, TabsList, TabsTrigger, TabsContent } = await server.ssrLoadModule("/src/components/ui/tabs.tsx");
        const { ToolAccessSettings } = await server.ssrLoadModule("/src/components/settings/tool-access-settings.tsx");
        const { AppServerSettingsCard } = await server.ssrLoadModule("/src/components/settings/app-server-settings-card.tsx");
        const { WorkspaceSettingsCard } = await server.ssrLoadModule("/src/components/settings/workspace-settings-card.tsx");
        const { RequestsTable } = await server.ssrLoadModule("/src/components/requests/requests-table.tsx");
        const { OutputTokenTooltip } = await server.ssrLoadModule("/src/components/metrics/token-tooltip.tsx");
        const { FastBadge } = await server.ssrLoadModule("/src/components/metrics/service-tier.tsx");
        const { setServerTimeZone } = await server.ssrLoadModule("/src/lib/format.ts");
        setServerTimeZone("UTC");
        const noop = () => {};
        const reset = () => { globalThis.fixtureState = []; };
        const render = element => {
          globalThis.fixtureStateCursor = 0;
          globalThis.fixtureButtons = [];
          globalThis.fixtureInputs = {};
          globalThis.fixtureSelects = [];
          return renderToStaticMarkup(h(MemoryRouter, null, h(LanguageContext.Provider, { value: { language: "zh", setLanguage: noop } }, h(TooltipProvider, null, element))));
        };
        const change = (id, value) => globalThis.fixtureInputs[id].onChange({ target: { value } });
        const click = label => globalThis.fixtureButtons.find(button => button.children === label).onClick();
        const output = {};
        reset();
        const tabs = orientation => h(Tabs, { orientation, defaultValue: "first" }, h(TabsList, null, h(TabsTrigger, { value: "first" }, "First"), h(TabsTrigger, { value: "second" }, "Second")), h(TabsContent, { value: "first" }, "Panel"));
        output.verticalTabs = render(tabs("vertical"));
        output.horizontalTabs = render(tabs("horizontal"));
        output.fast = render(h(FastBadge, { tier: "priority", source: "request", responseTier: "fast" }));
        output.reasoningOverflow = render(h(OutputTokenTooltip, { outputTokens: 10, reasoningOutputTokens: 20 }));
        output.reasoningMissingTotal = render(h(OutputTokenTooltip, { outputTokens: null, reasoningOutputTokens: 20 }));

        const previews = [];
        const management = { loading: false, error: null, saving: false, pendingSetting: null, lastAppliedSetting: null, actionError: null,
          previewSetting: (value, label) => { previews.push({ value, label }); }, confirmSetting: () => { throw Error("validation must not write settings"); }, cancelSetting: noop,
          codexSettings: { models: [], defaults: {}, compact: {}, defaultsEditable: true, toolSettings: { mergedAvailable: true,
            fields: [{ path: ["tools", "allowed"], label: "Allowed tools", type: "list", userValue: null, mergedValue: null }] } },
        };
        reset();
        const tool = () => h(ToolAccessSettings, { management });
        output.toolInitial = render(tool());
        change("tool-setting-value", "[");
        render(tool());
        click("预览修改");
        output.toolInvalid = render(tool());
        output.toolPreviewsAfterError = String(previews.length);
        management.codexSettings.toolSettings.fields[0].userValue = ["write"];
        output.toolInvalidAfterSnapshot = render(tool());
        change("tool-setting-value", '["read"]');
        output.toolCorrected = render(tool());
        click("预览修改");
        output.toolPreview = JSON.stringify(previews.pop());
        output.toolValid = render(tool());
        change("tool-setting-value", "");
        render(tool());
        click("预览修改");
        output.toolRemoved = JSON.stringify(previews.pop());
        reset();
        Object.assign(management.codexSettings.toolSettings.fields[0], { path: ["tools", "timeout"], label: "Tool timeout", type: "number", userValue: null });
        render(tool());
        change("tool-setting-value", "invalid-number");
        render(tool());
        click("预览修改");
        output.toolNumberInvalid = render(tool());
        change("tool-setting-value", "2");
        render(tool());
        click("预览修改");
        output.toolNumberPreview = JSON.stringify(previews.pop());
        management.loading = true;
        output.toolDisabled = render(tool());
        management.loading = false;

        const workspacePreviews = [];
        const workspaceManagement = { loading: false, error: null, saving: false, pendingSetting: null, lastAppliedSetting: null,
          managedSettings: { system: { workspaces: [{ id: "original-workspace", name: "Main", sandbox: null, approvalPolicy: null, permissions: null, approvalsReviewer: null, canEnableAutoReview: true, autoReviewUnavailableReason: null }] } },
          previewSetting: (...args) => workspacePreviews.push(args),
        };
        output.workspaceDefault = render(h(WorkspaceSettingsCard, { management: workspaceManagement }));
        const reviewer = globalThis.fixtureSelects.find(select => select.label === "工作区默认审批方式");
        output.workspaceOptions = JSON.stringify(reviewer.options);
        output.workspaceDefaultValue = reviewer.value;
        output.workspaceDisabledValues = JSON.stringify(reviewer.disabledValues);
        reviewer.onChange("auto_review"); reviewer.onChange("user"); reviewer.onChange("__clear__");
        output.workspacePreviews = JSON.stringify(workspacePreviews);
        workspaceManagement.pendingSetting = {};
        render(h(WorkspaceSettingsCard, { management: workspaceManagement }));
        output.workspacePendingDisabled = String(globalThis.fixtureSelects.find(select => select.label === "工作区默认审批方式").disabled);
        workspaceManagement.pendingSetting = null;
        workspaceManagement.managedSettings.system.workspaces[0].approvalsReviewer = "auto_review";
        render(h(WorkspaceSettingsCard, { management: workspaceManagement }));
        output.workspaceReviewerValue = globalThis.fixtureSelects.find(select => select.label === "工作区默认审批方式").value;
        for (const [state, reason] of [["Unsupported", null], ["Unavailable", "provider-config-unavailable"]]) {
          Object.assign(workspaceManagement.managedSettings.system.workspaces[0], { canEnableAutoReview: false, autoReviewUnavailableReason: reason });
          workspacePreviews.length = 0;
          render(h(WorkspaceSettingsCard, { management: workspaceManagement }));
          const restrictedReviewer = globalThis.fixtureSelects.find(select => select.label === "工作区默认审批方式");
          output["workspace" + state] = JSON.stringify({ value: restrictedReviewer.value, disabled: restrictedReviewer.disabled, disabledValues: restrictedReviewer.disabledValues, options: restrictedReviewer.options });
          restrictedReviewer.onChange("user"); restrictedReviewer.onChange("__clear__");
          output["workspace" + state + "Previews"] = JSON.stringify(workspacePreviews);
        }

        reset();
        const compact = () => h(AppServerSettingsCard, { management, section: "context" });
        render(compact());
        change("codex-context-window", "0");
        render(compact());
        click("保存压缩设置");
        output.invalidWindow = render(compact());
        change("codex-context-window", "1000");
        output.correctedWindow = render(compact());
        change("codex-compact-percent", "95");
        render(compact());
        click("保存压缩设置");
        output.invalidPercent = render(compact());
        change("codex-compact-percent", "80");
        change("codex-context-window", "");
        render(compact());
        click("保存压缩设置");
        output.percentNeedsWindow = render(compact());
        output.compactPreviewsAfterErrors = String(previews.length);
        management.codexSettings.compact.contextWindow = 1000;
        output.percentWindowAfterSnapshot = render(compact());
        click("保存压缩设置");
        output.compactPreview = JSON.stringify(previews.pop());
        output.compactValid = render(compact());
        change("codex-context-window", "");
        change("codex-compact-percent", "");
        render(compact());
        click("保存压缩设置");
        output.compactRemoved = JSON.stringify(previews.pop());
        management.loading = true;
        output.compactDisabled = render(compact());
        management.loading = false;
        reset();
        render(compact());
        change("codex-compact-percent", "95");
        render(compact());
        click("保存压缩设置");
        management.codexSettings.compact.contextWindow = 2000;
        output.invalidPercentAfterOtherSnapshot = render(compact());

        reset();
        const record = { id: 7, provider: "openai", recordedAtMs: 1000, inputTokens: 10, cachedInputTokens: null, outputTokens: 10, reasoningOutputTokens: null, cacheHitRate: null, source: "codex", status: "completed", firstTokenMs: null, totalDurationMs: null };
        render(h(RequestsTable, { records: [record], pageNumber: 1, pageSize: 10, hasPrevious: false, hasNext: false, onPrevious: noop, onNext: noop, onPageSizeChange: noop, sorting: [], onSortingChange: noop, filter: "", total: 1 }));
        const detailButton = globalThis.fixtureButtons.find(button => button.children === "查看" && button["aria-label"] === "查看请求");
        const trigger = { isConnected: true };
        let stopped = false;
        detailButton.onClick({ currentTarget: trigger, stopPropagation: () => { stopped = true; } });
        output.detailStopsRowClick = String(stopped);
        output.detailFocusTarget = String(globalThis.fixtureSheetContent.finalFocus() === trigger);
        trigger.isConnected = false;
        output.detailDetachedFocusFallback = String(globalThis.fixtureSheetContent.finalFocus());
        output.detailCloseLabel = globalThis.fixtureSheetContent.closeLabel;
        console.log(JSON.stringify(output));
      } finally { await server.close(); }
    `;
    result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000,
    })) as Record<string, string>;
  }, 35_000);

  it("passes vertical orientation to the primitive tab list", () => {
    const verticalList = result.verticalTabs!.match(/<div\b[^>]*role="tablist"[^>]*>/u)?.[0];
    const horizontalList = result.horizontalTabs!.match(/<div\b[^>]*role="tablist"[^>]*>/u)?.[0];
    expect(verticalList).toContain('aria-orientation="vertical"');
    expect(verticalList).toContain('data-orientation="vertical"');
    expect(horizontalList).toContain('data-orientation="horizontal"');
    expect(horizontalList).not.toContain('aria-orientation="vertical"');
  });

  it("uses the shared Fast size and clamps supplementary output token details", () => {
    expect(result.fast).toContain('data-size="sm"');
    expect(result.reasoningOverflow).toContain('aria-description="推理输出：20; 非推理输出：0"');
    expect(result.reasoningMissingTotal).toContain('aria-description="推理输出：20; 非推理输出：—"');
  });

  it("previews each Workspace approval reviewer choice with the original Workspace identity", () => {
    expect(result.workspaceDefaultValue).toBe("__clear__");
    expect(JSON.parse(result.workspaceDisabledValues!)).toEqual([]);
    expect(JSON.parse(result.workspaceOptions!)).toEqual([["__clear__", "跟随 Codex 默认"], ["user", "手动审批"], ["auto_review", "Auto-review（自动审查）"]]);
    expect(JSON.parse(result.workspacePreviews!)).toEqual(["auto_review", "user", null].map(value => ["workspace.permissions", { workspaceId: "original-workspace", update: { kind: "approvals-reviewer", value } }, { key: "settingsFields.workspaceApprovalsReviewer", params: { name: "Main" } }]));
    expect(result.workspacePendingDisabled).toBe("true");
    expect(result.workspaceReviewerValue).toBe("auto_review");
    expect(result.workspaceDefault).toContain("卸载后恢复");
    expect(result.workspaceDefault).toContain("已加载会话保留实际审批方式");
  });

  it.each(["Unsupported", "Unavailable"])("disables only enabling Auto-review for a Provider that is %s", state => {
    expect(JSON.parse(result[`workspace${state}`]!)).toEqual({ value: "auto_review", disabled: false, disabledValues: ["auto_review"], options: JSON.parse(result.workspaceOptions!) });
    expect(JSON.parse(result[`workspace${state}Previews`]!)).toEqual(["user", null].map(value => ["workspace.permissions", { workspaceId: "original-workspace", update: { kind: "approvals-reviewer", value } }, { key: "settingsFields.workspaceApprovalsReviewer", params: { name: "Main" } }]));
  });

  it("associates tool JSON errors with the input and clears errors while editing", () => {
    expect(input(result.toolInitial!, "tool-setting-value")).toContain('aria-describedby="tool-setting-value-description"');
    expect(input(result.toolInvalid!, "tool-setting-value")).toContain('aria-invalid="true"');
    expect(input(result.toolInvalid!, "tool-setting-value")).toContain('aria-describedby="tool-setting-value-description tool-setting-value-error"');
    expect(result.toolInvalid).toContain('data-invalid="true"');
    expect(result.toolInvalid).toMatch(/role="alert"[^>]*id="tool-setting-value-error"/u);
    expect(result.toolPreviewsAfterError).toBe("0");
    expect(input(result.toolInvalidAfterSnapshot!, "tool-setting-value")).toContain('value="["');
    expect(input(result.toolInvalidAfterSnapshot!, "tool-setting-value")).toContain('aria-invalid="true"');
    expect(result.toolCorrected).not.toContain('aria-invalid="true"');
    expect(result.toolCorrected).not.toContain('id="tool-setting-value-error"');
    expect(JSON.parse(result.toolPreview!)).toEqual({ value: { kind: "tool-access", path: ["tools", "allowed"], value: ["read"] }, label: "tools.allowed" });
    expect(JSON.parse(result.toolRemoved!).value.value).toBeNull();
    expect(input(result.toolNumberInvalid!, "tool-setting-value")).toContain('aria-invalid="true"');
    expect(result.toolNumberInvalid).toContain("请输入有效数字。");
    expect(JSON.parse(result.toolNumberPreview!).value).toEqual({ kind: "tool-access", path: ["tools", "timeout"], value: 2 });
    expect(input(result.toolDisabled!, "tool-setting-value")).toContain('disabled=""');
  });

  it("assigns compact validation errors to the responsible field and only previews valid values", () => {
    for (const key of ["invalidWindow", "percentNeedsWindow"]) {
      expect(input(result[key]!, "codex-context-window")).toContain('aria-invalid="true"');
      expect(input(result[key]!, "codex-context-window")).toContain('aria-describedby="codex-context-window-error"');
      expect(input(result[key]!, "codex-compact-percent")).not.toContain('aria-invalid="true"');
      expect(result[key]).toMatch(/role="alert"[^>]*id="codex-context-window-error"/u);
    }
    expect(input(result.invalidPercent!, "codex-compact-percent")).toContain('aria-invalid="true"');
    expect(input(result.invalidPercent!, "codex-compact-percent")).toContain('aria-describedby="codex-compact-percent-error"');
    expect(input(result.invalidPercent!, "codex-context-window")).not.toContain('aria-invalid="true"');
    expect(result.correctedWindow).not.toContain('aria-invalid="true"');
    expect(result.compactPreviewsAfterErrors).toBe("0");
    expect(input(result.percentWindowAfterSnapshot!, "codex-context-window")).toContain('value="1000"');
    expect(result.percentWindowAfterSnapshot).not.toContain('aria-invalid="true"');
    expect(result.percentWindowAfterSnapshot).not.toContain('id="codex-context-window-error"');
    expect(input(result.invalidPercentAfterOtherSnapshot!, "codex-context-window")).toContain('value="2000"');
    expect(input(result.invalidPercentAfterOtherSnapshot!, "codex-compact-percent")).toContain('value="95"');
    expect(input(result.invalidPercentAfterOtherSnapshot!, "codex-compact-percent")).toContain('aria-invalid="true"');
    expect(JSON.parse(result.compactPreview!)).toEqual({ value: { kind: "model-compact", contextWindow: 1000, autoCompactPercent: 80 }, label: { key: "settingsFields.contextCompaction" } });
    expect(JSON.parse(result.compactRemoved!).value).toEqual({ kind: "model-compact", contextWindow: null, autoCompactPercent: null });
    expect(result.compactValid).not.toContain('aria-invalid="true"');
    expect(input(result.compactDisabled!, "codex-context-window")).toContain('disabled=""');
    expect(input(result.compactDisabled!, "codex-compact-percent")).toContain('disabled=""');
  });

  it("returns the request Sheet focus target to its native detail button", () => {
    expect(result.detailStopsRowClick).toBe("true");
    expect(result.detailFocusTarget).toBe("true");
    expect(result.detailDetachedFocusFallback).toBe("true");
    expect(result.detailCloseLabel).toBe("关闭");
  });
});

function input(markup: string, id: string): string {
  return [...markup.matchAll(/<input\b[^>]*>/gu)].find(match => match[0].includes(`id="${id}"`))?.[0] ?? "";
}
