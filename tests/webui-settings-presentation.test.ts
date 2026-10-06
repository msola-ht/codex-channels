import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

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
        const stale=renderToStaticMarkup(h(ProviderSettingsManagement,{section:"providers",management:{settings,loading:false,error:"snapshot-load-failed",busy:false,pendingPreview:null,actionError:null,refetch(){},clearError(){}}}));
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

  it("设置、模型和渠道文案双语渲染且保留配置及用户数据", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", String.raw`
      import {createServer} from "vite";
      import {createElement as h} from "react";
      import {renderToStaticMarkup} from "react-dom/server";
      const server=await createServer({server:{middlewareMode:true},appType:"custom",logLevel:"silent"});
      try {
        const {LanguageContext}=await server.ssrLoadModule("/src/hooks/language-context.ts");
        const {GatewaySettingsCard}=await server.ssrLoadModule("/src/components/settings/gateway-settings-card.tsx");
        const {AppServerSettingsCard}=await server.ssrLoadModule("/src/components/settings/app-server-settings-card.tsx");
        const {ProviderSettingsManagement}=await server.ssrLoadModule("/src/components/settings/provider-settings-management.tsx");
        const {ProviderStatusCard,ChannelStatusCard}=await server.ssrLoadModule("/src/components/settings/provider-channel-status.tsx");
        const {ToolAccessSettings}=await server.ssrLoadModule("/src/components/settings/tool-access-settings.tsx");
        const {ManagedSelect}=await server.ssrLoadModule("/src/components/settings/settings-controls.tsx");
        const unexpected=()=>{throw Error("language rendering must not invoke management actions")};
        const render=(component,props,language)=>renderToStaticMarkup(h(LanguageContext.Provider,{value:{language,setLanguage:unexpected}},h(component,props)));
        const shared={loading:false,error:null,actionError:null,saving:false,busy:false,pendingSetting:null,pendingPreview:null,lastAppliedSetting:null,previewSetting:unexpected,confirmSetting:unexpected,cancelSetting:unexpected,refetch:unexpected,mutate:unexpected,confirm:unexpected,cancel:unexpected,clearError:unexpected};
        const managedSettings={revision:"r1",system:{sandbox:"workspace-write",approvalTimeoutSeconds:300,idleReleaseMinutes:5,modelTrafficMode:"production",modelTrafficDumpEnabled:false,modelTrafficRetentionDays:3,defaultWorkspace:"main",workspaces:[{id:"main",name:"Workspace main"}],officialTuiIdentity:{clientIdentity:{name:"fixture-client"},terminalIdentity:"fixture-terminal/1",upstreamUserAgent:"fixture-agent/1",defaults:{name:"codex",version:"fixture-version"}}},display:{operationUpdates:"compact",planUpdatesEnabled:true,reasoningEnabled:false},telegram:{configured:true,messageFormat:"rich"},automation:{scheduledTasksEnabled:false},advanced:{loggingLevel:"info",pluginApiEnabled:false}};
        const codexSettings={version:"fixture-version",provider:"fixture-provider",defaultsEditable:true,models:[{model:"model-fixture",displayName:"Fixture model",defaultReasoningEffort:"high",reasoningEfforts:[{effort:"high",description:"Fixture effort"}]}],defaults:{model:"model-fixture",reasoningEffort:"high",fastEnabled:false,webSearch:"cached",updatePlanEnabled:true,autoRecapEnabled:false},compact:{contextWindow:64000,autoCompactPercent:80}};
        const settings={defaults:{model:"model-fixture",reasoningEffort:"high"},managedProviders:[{id:"fixture-provider",displayName:"Fixture provider",model:"model-fixture",reasoningEffort:"high",models:[{id:"model-fixture",displayName:"Fixture model",contextWindow:64000,maxContextWindow:128000,reasoningEfforts:[{effort:"high",description:"Fixture effort"}]}]}],modelWindow:[{id:"model-fixture",displayName:"Fixture model",contextWindow:64000,maxContextWindow:128000,providers:["fixture-provider"],windowPercent:50,conflicts:true,perProvider:{"fixture-provider":50,"fixture-other":75}}],customProviders:{fixedCandidates:[{id:"custom-fixture",displayName:"Fixture custom",baseUrl:"https://fixture.invalid/v1",active:true,state:"configured",kind:"custom"}],switchingProviders:[],backupCandidates:[]}};
        const providerState={primary:{kind:"official",id:"openai",displayName:"OpenAI"},official:{authenticated:true},defaults:{model:"model-fixture",reasoningEffort:"high"},configVersion:7,providers:[{id:"custom-fixture",displayName:"Fixture custom",kind:"custom",mode:"switching",model:"model-fixture",modelCount:2,selected:false,state:"configured"},{id:"backup-fixture",displayName:"Fixture backup",kind:"custom",mode:"backup",model:null,modelCount:null,selected:false,state:"backup"}]};
        const channels=[{id:"feishu",displayName:"Feishu",enabled:true},{id:"telegram",displayName:"Telegram",enabled:false}];
        const toolFields=[
          {path:["mcp_servers","my-custom","tools","some_tool","output_token_limit"],label:"MCP my-custom / some_tool：输出 token 上限",type:"integer",userValue:1000,mergedValue:2000},
          {path:["plugins","my-plugin","mcp_servers","srv","enabled"],label:"插件 my-plugin / srv：启用",type:"boolean",userValue:true,mergedValue:true},
          {path:["plugins","my-plugin","mcp_servers","srv","tools","some_tool","output_token_limit"],label:"插件 my-plugin / srv / some_tool：输出 token 上限",type:"integer",userValue:3000,mergedValue:4000},
        ];
        const before=JSON.stringify({managedSettings,codexSettings,settings,providerState,channels,toolFields});
        const presentation=Object.fromEntries(["zh","en","zhAgain"].map(key=>{
          const language=key==="en"?"en":"zh";
          return [key,{
            gateway:Object.fromEntries(["general","permissions","network","data","display"].map(section=>[section,render(GatewaySettingsCard,{management:{...shared,managedSettings},section,upstreamAgent:{data:{effectiveUserAgent:"fixture-agent/1",recentRequestUserAgent:"fixture-agent/1",source:"override"},error:null,loading:false}},language)])),
            codex:Object.fromEntries(["general","models","context"].map(section=>[section,render(AppServerSettingsCard,{management:{...shared,codexSettings},section},language)])),
            provider:Object.fromEntries(["providers","models","context"].map(section=>[section,render(ProviderSettingsManagement,{management:{...shared,settings},section},language)])),
            tools:Object.fromEntries(toolFields.map(field=>[field.path.join("."),render(ToolAccessSettings,{management:{...shared,codexSettings:{...codexSettings,toolSettings:{mergedAvailable:true,fields:[field]}}}},language)])),
            status:render(ProviderStatusCard,{state:providerState},language),
            channels:render(ChannelStatusCard,{channels},language),
            emptyChannels:render(ChannelStatusCard,{channels:[]},language),
            unconfigured:render(ManagedSelect,{label:"Fixture",value:"",options:[],disabled:false,onChange:unexpected},language),
          }];
        }));
        const userData=render(ProviderStatusCard,{state:{...providerState,primary:{...providerState.primary,id:"用户-provider",displayName:"用户名称"},defaults:{model:"用户-model",reasoningEffort:"high"},providers:[]}},"en");
        const translatedChannel=render(ChannelStatusCard,{channels:[{id:"feishu",displayName:"飞书",enabled:true}]},"en");
        console.log(JSON.stringify({presentation,userData,translatedChannel,unchanged:before===JSON.stringify({managedSettings,codexSettings,settings,providerState,channels,toolFields})}));
      } finally {await server.close();}
    `], { cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    type Presentation = {
      gateway: Record<string, string>; codex: Record<string, string>; provider: Record<string, string>; tools: Record<string, string>;
      status: string; channels: string; emptyChannels: string; unconfigured: string;
    };
    const { presentation, userData, translatedChannel, unchanged } = JSON.parse(output) as {
      presentation: Record<"zh" | "en" | "zhAgain", Presentation>;
      userData: string; translatedChannel: string; unchanged: boolean;
    };
    expect(unchanged).toBe(true);
    expect(presentation.zhAgain).toEqual(presentation.zh);
    const english = presentation.en;
    for (const html of [
      ...Object.values(english.gateway), ...Object.values(english.codex), ...Object.values(english.provider), ...Object.values(english.tools),
      english.status, english.channels, english.emptyChannels, english.unconfigured,
    ]) {
      expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
      expect(html).not.toMatch(/\b(?:settingsFields|settingsUi|managementUi|modelManagement|channelSettings)\.[A-Za-z]/u);
      expect(html).not.toContain("undefined");
    }
    for (const html of [presentation.zh.gateway.network!, english.gateway.network!]) {
      expect(html).toContain('value="fixture-client"');
      expect(html).toContain('value="fixture-agent/1"');
      expect(html).toContain('value="fixture-terminal/1"');
    }
    for (const html of [presentation.zh.codex.context!, english.codex.context!]) {
      expect(html).toContain('value="64000"');
      expect(html).toContain('value="80"');
    }
    for (const html of [presentation.zh.provider.providers!, english.provider.providers!]) {
      expect(html).toContain("custom-fixture");
      expect(html).toContain("https://fixture.invalid/v1");
    }
    for (const html of [presentation.zh.provider.context!, english.provider.context!]) {
      expect(html).toContain("fixture-provider");
      expect(html).toContain("fixture-other 75%");
      expect(html).toContain('value="50"');
    }
    expect(presentation.zh.unconfigured).toContain("未配置");
    expect(english.unconfigured).toContain("Not configured");
    expect(presentation.zh.channels).toContain("已启用");
    expect(english.channels).toContain("Enabled");
    expect(english.channels).toContain("Configured, disabled");
    expect(userData).toContain("用户名称");
    expect(userData).toContain("用户-provider");
    expect(userData).toContain("用户-model");
    expect(translatedChannel).toContain("Feishu");
    expect(translatedChannel).not.toContain("飞书");
    expect(translatedChannel).toContain("Enabled");
    for (const language of ["zh", "en"] as const) {
      const tools = presentation[language].tools;
      expect(tools["mcp_servers.my-custom.tools.some_tool.output_token_limit"]).toContain("my-custom");
      expect(tools["mcp_servers.my-custom.tools.some_tool.output_token_limit"]).toContain("some_tool");
      expect(tools["mcp_servers.my-custom.tools.some_tool.output_token_limit"]).toContain('value="1000"');
      expect(tools["plugins.my-plugin.mcp_servers.srv.enabled"]).toContain("my-plugin");
      expect(tools["plugins.my-plugin.mcp_servers.srv.enabled"]).toContain("srv");
      expect(tools["plugins.my-plugin.mcp_servers.srv.tools.some_tool.output_token_limit"]).toContain("some_tool");
      expect(tools["plugins.my-plugin.mcp_servers.srv.tools.some_tool.output_token_limit"]).toContain('value="3000"');
    }
  }, 30_000);

  describe("确认弹窗展示", () => {
    let confirmations: { cancellation: string[]; removal: Record<string, string | boolean | number[]> };

    // 取消确认组件不依赖账户管理 Hook；两场景只共用弹窗呈现 mock。
    beforeAll(() => {
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", String.raw`
        import { createServer } from "vite";
        import { createElement as h } from "react";
        import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
        const server = await createServer({server:{middlewareMode:true},appType:"custom",logLevel:"silent",plugins:[{
          name:"confirmation-presentation-fixture",enforce:"pre",
          load(id) {
            if (id.endsWith("/hooks/use-account-settings-management.ts"))
              return 'export function useAccountSettingsManagement(){globalThis.managementCalls++;return globalThis.management}';
            if (!id.endsWith("/components/ui/alert-dialog.tsx")) return;
            return 'import {createElement as h} from "react"; const box=({children})=>h("div",null,children); const button=({children,disabled})=>h("button",{disabled},children); export const AlertDialog=box,AlertDialogContent=box,AlertDialogDescription=box,AlertDialogFooter=box,AlertDialogHeader=box,AlertDialogTitle=box,AlertDialogAction=button,AlertDialogCancel=button;';
          }
        }]});
        try {
          const {LanguageContext}=await server.ssrLoadModule("/src/hooks/language-context.ts");
          const cancellationScenario=async()=>{
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
            for(const [running,relayRunning] of [[true,false],[false,false],[false,true]]) {
              const tasks={saving:false,loading:false,pendingPreview:{input:{operation:"traffic",action:"cleanup"},preview:{...preview,resource:{dumps:{bytes:1024,v2Sessions:2},appServer:{running},modelRelay:{running:relayRunning}}}},confirm(){throw Error("must not confirm during render")},cancelPending(){throw Error("must not cancel during render")}};
              html.push(renderMarkup(h(LanguageContext.Provider,{value:{language:"en",setLanguage(){}}},h(ManagementTaskConfirmationDialog,{tasks}))));
            }
            return html;
          };
          const removalScenario=async()=>{
            const originalNow=Date.now;
            const originalManagement=Object.getOwnPropertyDescriptor(globalThis,"management");
            const originalManagementCalls=Object.getOwnPropertyDescriptor(globalThis,"managementCalls");
            try {
              Date.now=()=>1000;
              const {OpencodeGoUsageCard}=await server.ssrLoadModule("/src/components/overview/overview-sections.tsx");
              const {ServerTimeContext}=await server.ssrLoadModule("/src/hooks/use-server-time.ts");
              const {setServerTimeZone}=await server.ssrLoadModule("/src/lib/format.ts");setServerTimeZone("UTC");
              const pending={input:{operation:"opencode.account.remove",accountId:"main"},preview:{operation:"opencode.account.remove",account:{id:"main",displayName:"Account main"},provider:{name:"OpenCode Go",id:"ocg-main"},mode:"switching",model:"test-model",status:"ready",effects:{stopAppServer:true,removeAccount:true},activation:"restart-all"}};
              const before=JSON.stringify(pending);
              globalThis.management={settings:{opencodeGo:{accounts:[{id:"main"},{id:"other"}]}},loading:false,error:null,busy:false,pendingPreview:pending,actionError:null,refetch(){},cancel(){throw new Error("unexpected cancel")},confirm(){throw new Error("unexpected confirmation")},mutate(){throw new Error("unexpected mutation")}};
              const accounts=["main","other"].map(account=>({account,provider:"ocg-"+account,displayName:account,default:false,available:false,observedAtMs:1000,windows:[],subscriptionRequired:true}));
              const calls=[];
              const render=(language)=>{
                globalThis.managementCalls=0;
                const markup=renderMarkup(h(LanguageContext.Provider,{value:{language,setLanguage(){}}},h(ServerTimeContext.Provider,{value:{nowMs:1000,receivedAtMs:Date.now(),timeZone:"UTC"}},h(OpencodeGoUsageCard,{accounts,refreshControls:{},onAccountsChanged(){}}))));
                calls.push(globalThis.managementCalls);
                return markup;
              };
              const zh=render("zh"), en=render("en"), zhAgain=render("zh");
              globalThis.management.loading=true;
              const loading=render("en");
              globalThis.management.loading=false;
              globalThis.management.busy=true;
              const saving=render("en");
              globalThis.management.busy=false;
              globalThis.management.pendingPreview=null;
              globalThis.management.error="snapshot-load-failed";
              const failed=render("en");
              globalThis.management.loading=true;
              const retrying=render("en");
              globalThis.management.loading=false;
              globalThis.management.error=null;
              const recovered=render("en");
              globalThis.management.pendingPreview={...pending,input:{...pending.input,accountId:"other"},preview:{...pending.preview,account:{id:"other",displayName:"Account other"}}};
              const other=render("en");
              return {zh,en,zhAgain,loading,saving,failed,retrying,recovered,other,calls,unchanged:before===JSON.stringify(pending)};
            } finally {
              Date.now=originalNow;
              if (originalManagement) Object.defineProperty(globalThis,"management",originalManagement);
              else delete globalThis.management;
              if (originalManagementCalls) Object.defineProperty(globalThis,"managementCalls",originalManagementCalls);
              else delete globalThis.managementCalls;
            }
          };
          console.log(JSON.stringify({cancellation:await cancellationScenario(),removal:await removalScenario()}));
        } finally {await server.close();}
      `], { cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
      confirmations = JSON.parse(output) as typeof confirmations;
    }, 35_000);

    it("keeps cancellation available while confirmations wait for a snapshot", () => {
      const html = confirmations.cancellation;
      for (const index of [0, 3, 4, 5]) {
        expect(html[index]).toContain('<button>取消</button>');
        expect(html[index]).toMatch(/<button disabled="">[\s\S]*正在刷新…<\/button>/u);
      }
      expect(html[1]).toContain('<button disabled="">取消</button>');
      expect(html[1]).toContain("处理中…");
      expect(html[2]).toContain('<button>确认写入</button>');
      for (const index of [6, 7, 8]) {
        expect(html[index]).not.toMatch(/[\u4e00-\u9fff]/u);
        expect(html[index]).toContain("All App Servers and Relay must be stopped");
        expect(html[index]).toContain("This cannot be undone");
        expect(html[index]).toContain("codexc traffic cleanup --confirm");
        expect(html[index]).toContain("2 V2 batches");
        expect(html[index]).toContain("<button>Cancel</button>");
      }
      expect(html[6]).toContain('<button disabled="">Confirm execution</button>');
      expect(html[7]).toContain('<button>Confirm execution</button>');
      expect(html[8]).toContain('<button disabled="">Confirm execution</button>');
    }, 30_000);

    it("localizes the console account removal confirmation and preserves busy guards", () => {
      const result = confirmations.removal;
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
      expect((result.en as string).match(/Confirm account removal/gu)).toHaveLength(1);
      expect((result.other as string).match(/Confirm account removal/gu)).toHaveLength(1);
      expect(result.other).toContain("Account other (other)");
      expect(result.other).not.toContain("Account main (main)");
      expect(result.calls).toEqual(Array(9).fill(1));
      const buttons = (markup: string, label: string) => [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].filter(([button]) => button.includes(label));
      const retries = buttons(result.failed as string, "Retry loading account configuration");
      expect(retries).toHaveLength(2);
      for (const [button] of retries) expect(button).not.toMatch(/\sdisabled(?:=|\s|>)/u);
      for (const [button] of buttons(result.failed as string, "Remove local account")) expect(button).toMatch(/\sdisabled(?:=|\s|>)/u);
      for (const [button] of buttons(result.retrying as string, "Retry loading account configuration")) expect(button).toMatch(/\sdisabled(?:=|\s|>)/u);
      for (const [button] of buttons(result.recovered as string, "Remove local account")) expect(button).not.toMatch(/\sdisabled(?:=|\s|>)/u);
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
});
