import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 与现有 WebUI 展示合同相同，直接渲染生产组件，不复制组件的条件分支。
describe("WebUI 状态与关联范围展示", () => {
  it("distinguishes zero balance, stale settings and scoped requests", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", String.raw`
      import { createServer } from "vite";
      import { createElement as h } from "react";
      import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
      const server = await createServer({server:{middlewareMode:true},appType:"custom",logLevel:"silent"});
      try {
        const {LanguageContext}=await server.ssrLoadModule("/src/hooks/language-context.ts");
        const renderToStaticMarkup=(element)=>renderMarkup(h(LanguageContext.Provider,{value:{language:"zh",setLanguage(){}}},element));
        const {setServerTimeZone}=await server.ssrLoadModule("/src/lib/format.ts"); setServerTimeZone("UTC");
        const {DeepseekBalanceCards}=await server.ssrLoadModule("/src/components/overview/overview-sections.tsx");
        const {ServerTimeContext}=await server.ssrLoadModule("/src/hooks/use-server-time.ts");
        const {TooltipProvider}=await server.ssrLoadModule("/src/components/ui/tooltip.tsx");
        const {QueryFilters}=await server.ssrLoadModule("/src/components/metrics/query-filters.tsx");
        const {ProviderSettingsManagement}=await server.ssrLoadModule("/src/components/settings/provider-settings-management.tsx");
        const zero=renderToStaticMarkup(h(ServerTimeContext.Provider,{value:{nowMs:1000,receivedAtMs:Date.now(),timeZone:"UTC"}},h(DeepseekBalanceCards,{accounts:[{provider:"ds-main",account:"main",displayName:"DeepSeek",default:true,available:false,observedAtMs:1000,balances:[{currency:"CNY",totalBalance:"0.00",grantedBalance:"0.00",toppedUpBalance:"0.00"}]}],refreshControls:{}})));
        const filter=renderToStaticMarkup(h(TooltipProvider,null,h(QueryFilters,{query:{range:"all",threadId:"scoped-thread",turnId:"scoped-turn"},onChange(){},showThreadFilters:false})));
        const settings={defaults:{},managedProviders:[],modelWindow:[],customProviders:{fixedCandidates:[],switchingProviders:[],backupCandidates:[]}};
        const stale=renderToStaticMarkup(h(ProviderSettingsManagement,{management:{settings,loading:false,error:"snapshot-load-failed",busy:false,pendingPreview:null,actionError:null,refetch(){},clearError(){}}}));
        const button=[...stale.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match=>match[0].includes("切回官方 OpenAI"))?.[0] ?? "";
        console.log(JSON.stringify({zero,filter,stale,button}));
      } finally { await server.close(); }
    `], { cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000 });
    const result = JSON.parse(output) as Record<string, string>;
    expect(result.zero).toContain("¥0.00");
    expect(result.zero).not.toContain("暂未获取到账户数据");
    expect(result.filter).toContain("scoped-thread");
    expect(result.filter).toContain("scoped-turn");
    expect(result.filter).toContain('aria-label="清除会话筛选"');
    expect(result.filter).toContain('aria-label="清除轮次筛选"');
    expect(result.stale).toContain("snapshot-load-failed");
    expect(result.button).toMatch(/\sdisabled(?:=|\s|>)/u);
  }, 30_000);
  it("keeps cancellation available while confirmations wait for a snapshot", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", String.raw`
      import { createServer } from "vite";
      import { createElement as h } from "react";
      import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
      const server = await createServer({server:{middlewareMode:true},appType:"custom",logLevel:"silent",plugins:[{
        name:"dialog-without-browser-portal",enforce:"pre",
        load(id) {
          if (!id.endsWith("/components/ui/alert-dialog.tsx")) return;
          return 'import {createElement as h} from "react"; const box=({children})=>h("div",null,children); const button=({children,disabled})=>h("button",{disabled},children); export const AlertDialog=box,AlertDialogContent=box,AlertDialogDescription=box,AlertDialogFooter=box,AlertDialogHeader=box,AlertDialogTitle=box,AlertDialogAction=button,AlertDialogCancel=button;';
        }
      }]});
      try {
        const {LanguageContext}=await server.ssrLoadModule("/src/hooks/language-context.ts");
        const renderToStaticMarkup=(element)=>renderMarkup(h(LanguageContext.Provider,{value:{language:"zh",setLanguage(){}}},element));
        const {ManagementConfirmationDialog,PendingSettingDialog}=await server.ssrLoadModule("/src/components/settings/settings-controls.tsx");
        const {AccountSettingsConfirmationDialog}=await server.ssrLoadModule("/src/components/settings/account-settings-management.tsx");
        const {ManagementTaskConfirmationDialog}=await server.ssrLoadModule("/src/components/settings/management-task-controls.tsx");
        const base={open:true,title:"test",description:"test",onConfirm(){},onCancel(){}};
        const pending={kind:"test",label:"test",value:1,before:0,activation:{status:"none",commands:[]}};
        const html = [
          ...[{saving:false,loading:true},{saving:true,loading:false},{saving:false,loading:false}].map(state=>renderToStaticMarkup(h(ManagementConfirmationDialog,{...base,...state}))),
          renderToStaticMarkup(h(PendingSettingDialog,{...base,pending,saving:false,loading:true})),
          renderToStaticMarkup(h(AccountSettingsConfirmationDialog,{...base,pending:{input:{operation:"deepseek.remove"},preview:{operation:"remove"}},saving:false,loading:true})),
          renderToStaticMarkup(h(ManagementTaskConfirmationDialog,{tasks:{saving:false,loading:true,pendingPreview:{input:{operation:"metrics",action:"clear"},preview:{operation:"metrics",action:"clear",effects:[],preconditions:[]}},confirm(){},cancelPending(){}}}))
        ];
        const {WebuiManagementTaskRunner}=await import("../scripts/webui-management-tasks.mjs");
        const preview=new WebuiManagementTaskRunner({now:()=>1000}).preview({operation:"traffic",action:"cleanup"});
        for(const running of [true,false]) {
          const tasks={saving:false,loading:false,pendingPreview:{input:{operation:"traffic",action:"cleanup"},preview:{...preview,resource:{dumps:{bytes:1024,v2Sessions:2,legacyFiles:3},appServer:{running}}}},confirm(){throw Error("must not confirm during render")},cancelPending(){throw Error("must not cancel during render")}};
          html.push(renderMarkup(h(LanguageContext.Provider,{value:{language:"en",setLanguage(){}}},h(ManagementTaskConfirmationDialog,{tasks}))));
        }
        console.log(JSON.stringify(html));
      } finally {await server.close();}
    `], { cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000 });
    const html = JSON.parse(output) as string[];
    for (const index of [0, 3, 4, 5]) {
      expect(html[index]).toContain('<button>取消</button>');
      expect(html[index]).toMatch(/<button disabled="">[\s\S]*正在刷新…<\/button>/u);
    }
    expect(html[1]).toContain('<button disabled="">取消</button>');
    expect(html[1]).toContain("处理中…");
    expect(html[2]).toContain('<button>确认写入</button>');
    for (const index of [6, 7]) {
      expect(html[index]).not.toMatch(/[\u4e00-\u9fff]/u);
      expect(html[index]).toContain("All App Servers must be stopped");
      expect(html[index]).toContain("This cannot be undone");
      expect(html[index]).toContain("codexc traffic cleanup --confirm");
      expect(html[index]).toContain("2 V2 batches and 3 legacy files");
      expect(html[index]).toContain("<button>Cancel</button>");
    }
    expect(html[6]).toContain('<button disabled="">Confirm execution</button>');
    expect(html[7]).toContain('<button>Confirm execution</button>');
  }, 30_000);

  it("localizes the console account removal confirmation and preserves busy guards", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", String.raw`
      import { createServer } from "vite";
      import { createElement as h } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      const server = await createServer({server:{middlewareMode:true},appType:"custom",logLevel:"silent",plugins:[{
        name:"removal-preview-fixture",enforce:"pre",
        load(id) {
          if (id.endsWith("/hooks/use-account-settings-management.ts"))
            return 'export function useAccountSettingsManagement(){return globalThis.management}';
          if (!id.endsWith("/components/ui/alert-dialog.tsx")) return;
          return 'import {createElement as h} from "react"; const box=({children})=>h("div",null,children); const button=({children,disabled})=>h("button",{disabled},children); export const AlertDialog=box,AlertDialogContent=box,AlertDialogDescription=box,AlertDialogFooter=box,AlertDialogHeader=box,AlertDialogTitle=box,AlertDialogAction=button,AlertDialogCancel=button;';
        }
      }]});
      try {
        const {LanguageContext}=await server.ssrLoadModule("/src/hooks/language-context.ts");
        const {AccountSubscriptionNotice}=await server.ssrLoadModule("/src/components/overview/account-subscription-notice.tsx");
        const pending={input:{operation:"opencode.account.remove",accountId:"main"},preview:{operation:"opencode.account.remove",account:{id:"main",displayName:"Account main"},provider:{name:"OpenCode Go",id:"ocg-main"},mode:"switching",model:"test-model",status:"ready",effects:{stopAppServer:true,removeAccount:true},activation:"restart-all"}};
        const before=JSON.stringify(pending);
        globalThis.management={settings:{opencodeGo:{accounts:[{id:"main"}]}},loading:false,error:null,busy:false,pendingPreview:pending,actionError:null,refetch(){},cancel(){throw new Error("unexpected cancel")},confirm(){throw new Error("unexpected confirmation")},mutate(){throw new Error("unexpected mutation")}};
        const render=(language)=>renderToStaticMarkup(h(LanguageContext.Provider,{value:{language,setLanguage(){}}},h(AccountSubscriptionNotice,{accountId:"main",onRemoved(){}})));
        const zh=render("zh"), en=render("en"), zhAgain=render("zh");
        globalThis.management.loading=true;
        const loading=render("en");
        globalThis.management.loading=false;
        globalThis.management.busy=true;
        const saving=render("en");
        console.log(JSON.stringify({zh,en,zhAgain,loading,saving,unchanged:before===JSON.stringify(pending)}));
      } finally {await server.close();}
    `], { cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000 });
    const result = JSON.parse(output) as Record<string, string | boolean>;
    expect(result.zh).toContain("确认删除账户");
    expect(result.zhAgain).toBe(result.zh);
    expect(result.unchanged).toBe(true);
    expect(result.en).toContain("Confirm account removal");
    expect(result.en).toContain("past Threads cannot be recovered");
    expect(result.en).toContain("does not cancel or renew the official subscription");
    expect(result.en).toContain("Operation: opencode.account.remove");
    expect(result.en).toContain("Account main (main)");
    expect(result.en).toContain("Activation target: restart-all");
    expect(result.en).toContain("stopAppServer=true; removeAccount=true");
    expect(result.en).toContain("<button>Confirm removal</button>");
    for (const state of [result.en, result.loading, result.saving]) {
      expect(state).not.toMatch(/[\u4e00-\u9fff]/u);
    }
    expect(result.loading).toContain("<button>Cancel</button>");
    expect(result.loading).toMatch(/<button disabled="">[\s\S]*Refreshing…<\/button>/u);
    expect(result.saving).toContain('<button disabled="">Cancel</button>');
    expect(result.saving).toContain("Processing…");
    expect(result.saving).toContain('aria-label="Loading…"');
  }, 30_000);

});
