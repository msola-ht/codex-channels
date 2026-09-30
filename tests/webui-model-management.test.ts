import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("separates model settings from general preferences and renders model submenus and account tables", () => {
  const script = String.raw`
    import {createServer} from 'vite';
    import {createElement as h} from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router';
    const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent'});
    try {
      const {LanguageContext}=await server.ssrLoadModule('/src/hooks/language-context.ts');
      const {TooltipProvider}=await server.ssrLoadModule('/src/components/ui/tooltip.tsx');
      const {SidebarProvider}=await server.ssrLoadModule('/src/components/ui/sidebar.tsx');
      const {AppSidebar}=await server.ssrLoadModule('/src/components/layout/app-sidebar.tsx');
      const {AppServerSettingsCard}=await server.ssrLoadModule('/src/components/settings/app-server-settings-card.tsx');
      const {ProviderSettingsManagement}=await server.ssrLoadModule('/src/components/settings/provider-settings-management.tsx');
      const {AccountSettingsManagement}=await server.ssrLoadModule('/src/components/settings/account-settings-management.tsx');
      const {modelNavItems}=await server.ssrLoadModule('/src/lib/navigation.ts');
      const render=(element,language='zh',path='/models/accounts')=>renderToStaticMarkup(h(MemoryRouter,{initialEntries:[path]},h(LanguageContext.Provider,{value:{language,setLanguage(){}}},h(TooltipProvider,null,element))));
      const base={loading:false,error:null,actionError:null,saving:false,busy:false,pendingSetting:null,pendingPreview:null,refetch(){},clearError(){}};
      const codex={...base,codexSettings:{provider:'openai',defaultsEditable:true,defaults:{model:'test-model',reasoningEffort:'medium',fastEnabled:true},compact:{contextWindow:10000,autoCompactPercent:80},permissions:{editable:true},models:[{model:'test-model',displayName:'Test model',defaultReasoningEffort:'medium',reasoningEfforts:[{effort:'medium'}]}]}};
      const providers={...base,settings:{defaults:{},managedProviders:[{id:'ds-main',displayName:'DeepSeek',model:'test-model',reasoningEffort:'medium',models:[{id:'test-model',displayName:'Test model',reasoningEfforts:[{effort:'medium'}]}]}],modelWindow:[{id:'test-model',displayName:'Test model',providers:['ds-main'],contextWindow:10000,maxContextWindow:20000,windowPercent:50}],customProviders:{fixedCandidates:[],switchingProviders:[],backupCandidates:[]}}};
      const accounts={...base,settings:{opencodeGo:{accounts:[]},deepseek:{accounts:[{id:'main',model:'test-model',mode:'switching',default:true}],legacyConfigurationPresent:false},clinePass:{accounts:[]}}};
      const general=render(h(AppServerSettingsCard,{management:codex}));
      const permissions=render(h(AppServerSettingsCard,{management:codex,section:"permissions"}));
      const models=render(h(AppServerSettingsCard,{management:codex,section:'models'}));
      const context=render(h(AppServerSettingsCard,{management:codex,section:'context'}));
      const custom=render(h(ProviderSettingsManagement,{management:providers,section:'providers'}));
      const defaults=render(h(ProviderSettingsManagement,{management:providers,section:'models'}));
      const windows=render(h(ProviderSettingsManagement,{management:providers,section:'context'}));
      const account=render(h(AccountSettingsManagement,{management:accounts}));
      const en=render(h(AccountSettingsManagement,{management:accounts}),'en');
      const sidebar=render(h(SidebarProvider,null,h(AppSidebar)));
      console.log(JSON.stringify({general,permissions,models,context,custom,defaults,windows,account,en,sidebar,paths:modelNavItems.map(item=>item.to)}));
    } finally {await server.close();}
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as Record<string, string> & {paths: string[]};
  expect(result.general).not.toContain("Sandbox");
  expect(result.permissions).toContain("Sandbox");
  expect(result.permissions).not.toContain("Plan 思考等级");
  expect(result.general).toContain("Plan 思考等级");
  expect(result.general).not.toContain("codex-context-window");
  expect(result.general).not.toMatch(/>默认模型<|>Fast</u);
  expect(result.models).toMatch(/>默认模型<|>Fast</u);
  expect(result.models).not.toContain("Sandbox");
  expect(result.models).not.toContain("codex-context-window");
  expect(result.context).toContain("codex-context-window");
  expect(result.context).not.toContain("Sandbox");
  expect(result.custom).toContain("新增提供商");
  expect(result.custom).not.toContain("保存模型上下文窗口");
  expect(result.defaults).toContain("保存托管 Provider 默认值");
  expect(result.defaults).not.toContain("新增提供商");
  expect(result.windows).toContain("保存模型上下文窗口");
  expect(result.windows).toContain("<table");
  expect(result.account).toContain("<table");
  expect(result.account).toContain('aria-label="平台"');
  expect(result.account).not.toContain('type="password"');
  expect(result.en).toContain("Accounts &amp; credentials");
  expect(result.paths).toHaveLength(4);
  for (const path of result.paths) expect(result.sidebar).toContain('href="' + path + '"');
  expect(result.sidebar).toContain('aria-expanded="true"');
  expect(result.sidebar).toContain('aria-current="page"');
});
