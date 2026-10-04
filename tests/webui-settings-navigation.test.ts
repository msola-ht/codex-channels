import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps settings fields and maintenance actions in their owning pages", () => {
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
      const {AppSidebar,AppSidebarProvider}=await server.ssrLoadModule('/src/components/layout/app-sidebar.tsx');
      const {GatewaySettingsCard}=await server.ssrLoadModule('/src/components/settings/gateway-settings-card.tsx');
      const {WebuiDataSettingsCard}=await server.ssrLoadModule('/src/components/settings/webui-data-settings-card.tsx');
      const {ManagementTaskControls}=await server.ssrLoadModule('/src/components/settings/management-task-controls.tsx');
      const {ChannelStatusCard}=await server.ssrLoadModule('/src/components/settings/provider-channel-status.tsx');
      const {ManagedSelect}=await server.ssrLoadModule('/src/components/settings/settings-controls.tsx');
      const {SettingsCliCommands}=await server.ssrLoadModule('/src/components/settings/settings-cli-commands.tsx');
      const {navItems,navGroups}=await server.ssrLoadModule('/src/lib/navigation.ts');
      const render=(element,path='/settings')=>renderToStaticMarkup(h(MemoryRouter,{initialEntries:[path]},h(LanguageContext.Provider,{value:{language:'zh',setLanguage(){}}},h(TooltipProvider,null,element))));
      const managedSettings={revision:'r1',system:{sandbox:'workspace-write',approvalTimeoutSeconds:300,idleReleaseMinutes:5,modelTrafficMode:'production',modelTrafficDumpEnabled:false,modelTrafficRetentionDays:3,defaultWorkspace:'main',workspaces:[{id:'main',name:'Main'}],officialTuiIdentity:{clientIdentity:{},defaults:{name:'codex',version:'test'}}},display:{operationUpdates:'compact',planUpdatesEnabled:true,reasoningEnabled:false},telegram:{configured:true,messageFormat:'html'},automation:{scheduledTasksEnabled:false},advanced:{loggingLevel:'info',pluginApiEnabled:false},metrics:{storage:{retentionDays:30,maxRows:10000}},webui:{host:'127.0.0.1',port:8788,tokenConfigured:false},network:{configuredFields:[]}};
      const management={managedSettings,loading:false,error:null,saving:false,pendingSetting:null,lastAppliedSetting:null,previewSetting(){throw new Error('unexpected mutation')}};
      const gateway=Object.fromEntries(['general','permissions','network','data','display'].map(section=>[section,render(h(GatewaySettingsCard,{management,section}))]));
      const data=render(h(WebuiDataSettingsCard,{management,section:'data'}));
      const network=render(h(WebuiDataSettingsCard,{management,section:'network'}));
      const stale=render(h(GatewaySettingsCard,{management:{...management,error:'stale'},section:'display'}));
      const tasks={tasks:[],loading:false,error:null,saving:false,pendingPreview:null};
      const maintenance=Object.fromEntries(['data','services'].map(section=>[section,render(h(ManagementTaskControls,{tasks,section}))]));
      const pruneEmpty=render(h(ManagementTaskControls,{tasks,section:'data',providerIds:[]}));
      const pruneCustom=render(h(ManagementTaskControls,{tasks,section:'data',providerIds:['custom-main']}));
      const sidebarPreferences=Object.fromEntries([['closed','sidebar_state=false'],['open','sidebar_state=true'],['missing',''],['invalid','sidebar_state=invalid']].map(([key,cookie])=>{
        globalThis.document={cookie};
        try {return [key,render(h(AppSidebarProvider,null,h(AppSidebar)))];}
        finally {delete globalThis.document;}
      }));
      globalThis.document={get cookie(){throw new Error('storage unavailable')}};
      try {sidebarPreferences.unavailable=render(h(AppSidebarProvider,null,h(AppSidebar)));}
      finally {delete globalThis.document;}
      const sidebarHome=render(h(AppSidebarProvider,null,h(AppSidebar)),"/");
      const sidebars=Object.fromEntries(navGroups.map(group=>[group.id,render(h(SidebarProvider,null,h(AppSidebar)),group.children.at(-1).to)]));
      const nestedSidebars=Object.fromEntries(['/threads/parent%2Fthread','/threads/parent%2Fthread/subagents'].map(path=>[path,render(h(SidebarProvider,null,h(AppSidebar)),path)]));
      const described=render(h(ManagedSelect,{label:'Mode',description:'Capture scope',value:'production',options:[['production','Production']],disabled:false,onChange(){}}));
      const channelEnglish=renderToStaticMarkup(h(LanguageContext.Provider,{value:{language:'en',setLanguage(){}}},h(ChannelStatusCard,{channels:[{id:'feishu',displayName:'Feishu',enabled:true}]})));
      const cliError=render(h(SettingsCliCommands,{scope:'general',summary:{data:null,error:'summary unavailable',loading:false,refetch(){}}}));
      const cliReady=render(h(SettingsCliCommands,{scope:'general',summary:{data:{cli:[{id:'gateway-config',label:'Gateway command',command:'codexc config',detail:'fixture'},{id:'channels',label:'Channel command',command:'codexc channels',detail:'fixture'}]},error:null,loading:false,refetch(){}}}));
      console.log(JSON.stringify({sidebarHome,sidebarPreferences,pruneEmpty,pruneCustom,described,channelEnglish,cliError,cliReady,gateway,data,network,stale,maintenance,sidebars,nestedSidebars,groups:navGroups,paths:navItems.map(item=>item.to)}));
    } finally {await server.close();}
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as {
    sidebarHome: string;
    sidebarPreferences: Record<string, string>;
    pruneEmpty: string; pruneCustom: string; described: string; channelEnglish: string; cliError: string; cliReady: string;
    gateway: Record<string, string>; data: string; network: string; stale: string;
    maintenance: Record<string, string>; sidebars: Record<string, string>; paths: string[];
    nestedSidebars: Record<string, string>;
    groups: { id: string; children: {to: string}[] }[];
  };
  expect(result.sidebarHome).toContain('aria-label="收起调用监控"');
  expect(result.sidebarHome).toContain('aria-label="收起模型管理"');
  expect(result.sidebarHome).toContain('aria-label="收起消息渠道"');
  expect(result.sidebarHome).toContain('aria-label="展开设置"');
  expect(result.groups.find(group => group.id === "relay")?.children.map(item => item.to)).toEqual(["/relay", "/relay/queue"]);
  expect(result.groups.find(group => group.id === "threads")?.children.map(item => item.to)).toEqual(["/threads", "/subagents"]);
  expect(result.sidebars.threads).toContain('aria-label="收起会话"');
  for (const [path, html] of Object.entries(result.nestedSidebars)) {
    const target = path.endsWith("/subagents") ? "/subagents" : "/threads";
    expect(html).toMatch(new RegExp('<a(?=[^>]*data-active="")(?=[^>]*aria-current="page")(?=[^>]*href="' + target + '")[^>]*>', "u"));
    expect([...html.matchAll(/aria-current="page"/gu)]).toHaveLength(1);
  }
  expect(result.sidebars.relay).toContain('aria-label="收起模型转发"');
  expect(result.sidebars.relay).toMatch(/<a(?=[^>]*data-active="")(?=[^>]*href="\/relay\/queue")[^>]*>/u);
  expect(result.sidebars.settings).toContain('aria-label="收起设置"');
  expect(result.sidebarPreferences.closed).toContain('data-collapsible="icon"');
  expect(result.sidebarPreferences.closed).toContain('aria-label="展开设置"');
  expect(result.sidebarPreferences.closed).not.toContain('data-slot="sidebar-menu-sub"');
  const activeGroup = [...result.sidebarPreferences.closed!.matchAll(/<button\b([^>]*)>/gu)]
    .find(match => match[1]!.includes('aria-label="展开设置"'));
  expect(activeGroup?.[1]).toContain('data-active=""');
  expect(activeGroup?.[1]).toContain('aria-expanded="false"');
  for (const state of ['open','missing','invalid','unavailable']) {
    expect(result.sidebarPreferences[state]).toContain('data-state="expanded"');
    expect(result.sidebarPreferences[state]).not.toContain('data-collapsible="icon"');
  }
  const routes = [...readFileSync(new URL("../webui/src/App.tsx", import.meta.url), "utf8")
    .matchAll(/<Route path="([^"]+)"/gu)].map(match => match[1]);
  for (const path of result.paths) expect(routes).toContain(path);
  expect(new Set(result.groups.map(group => group.id)).size).toBe(result.groups.length);
  expect(result.pruneEmpty).toMatch(/id="management-prune-provider"[^>]*value=""/u);
  expect(result.pruneEmpty).toMatch(/<button[^>]*disabled=""[^>]*>清理<\/button>/u);
  expect(result.pruneCustom).toMatch(/id="management-prune-provider"[^>]*value="custom-main"/u);
  const descriptionId = result.described.match(/aria-describedby="([^"]+)"/u)?.[1];
  expect(descriptionId).toBeTruthy();
  expect(result.described).toContain(`id="${descriptionId}">Capture scope`);
  expect(result.described).toContain('data-slot="field-content"');
  expect(result.described).toMatch(/data-slot="select-value"[^>]*>Production<\/span>/u);
  expect(result.channelEnglish).toContain('Channel');
  expect(result.channelEnglish).toContain('Enabled');
  expect(result.channelEnglish).not.toContain('已启用');
  expect(result.cliError).toContain('summary unavailable');
  expect(result.cliReady).toContain('Gateway command');
  expect(result.cliReady).not.toContain('Channel command');
  const ownership = {
    general: ["空闲自动解除", "计划任务"], permissions: ["默认 Workspace", "审批超时", "Sandbox"],
    network: ["Plugin API", "官方 TUI 请求身份"], data: ["记录调用详情", "调用记录保留天数", "日志等级"],
    display: ["Telegram 消息格式", "操作详情", "计划更新", "思考状态"],
  };
  for (const [section, labels] of Object.entries(ownership)) {
    for (const [other, html] of Object.entries(result.gateway)) {
      for (const label of labels) {
        if (section === other) expect(html).toContain(label);
        else expect(html).not.toContain(label);
      }
    }
  }
  expect(result.data).toContain("metrics-retention-days");
  expect(result.data).not.toContain("webui-token");
  expect(result.network).toContain("webui-token");
  expect(result.network).toContain("proxy-http_proxy");
  expect(result.network).not.toContain("metrics-retention-days");
  expect(result.stale).toMatch(/<button[^>]*disabled/u);
  expect(result.maintenance.services).toContain("更新源码");
  expect(result.maintenance.services).not.toContain("清理指标库");
  expect(result.maintenance.data).toContain("清理指标库");
  expect(result.maintenance.data).not.toContain("更新源码");
  expect(new Set(result.paths).size).toBe(result.paths.length);
  for (const group of result.groups) {
    const html = result.sidebars[group.id]!;
    expect(html).not.toContain("只读模式");
    expect(html).not.toContain("/api/v1");
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).toContain("Codex WebUI");
    for (const child of group.children) expect(html).toContain(`href="${child.to}"`);
    const parentButtons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)]
      .filter(match => match[1]!.includes('data-sidebar="menu-button"') && match[2]!.includes('data-expanded='));
    expect(parentButtons).toHaveLength(result.groups.length);
    for (const button of parentButtons) {
      expect(button[1]).not.toContain("href=");
      expect(button[1]).toContain("aria-expanded=");
      expect(button[2]).not.toContain("<a ");
    }
    expect(html).not.toMatch(/<a\b[^>]*data-sidebar="menu-button"[^>]*aria-expanded=/u);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-current="page"');
  }
});
