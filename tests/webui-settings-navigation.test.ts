import { execFileSync } from "node:child_process";
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
      const {AppSidebar}=await server.ssrLoadModule('/src/components/layout/app-sidebar.tsx');
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
      const sidebars=Object.fromEntries(navGroups.map(group=>[group.to,render(h(SidebarProvider,null,h(AppSidebar)),group.children.at(-1).to)]));
      const described=render(h(ManagedSelect,{label:'Mode',description:'Capture scope',value:'production',options:[['production','Production']],disabled:false,onChange(){}}));
      const channelEnglish=renderToStaticMarkup(h(LanguageContext.Provider,{value:{language:'en',setLanguage(){}}},h(ChannelStatusCard,{channels:[{id:'feishu',displayName:'Feishu',enabled:true}]})));
      const cliError=render(h(SettingsCliCommands,{scope:'general',summary:{data:null,error:'summary unavailable',loading:false,refetch(){}}}));
      const cliReady=render(h(SettingsCliCommands,{scope:'general',summary:{data:{cli:[{id:'gateway-config',label:'Gateway command',command:'codexc config',detail:'fixture'},{id:'channels',label:'Channel command',command:'codexc channels',detail:'fixture'}]},error:null,loading:false,refetch(){}}}));
      console.log(JSON.stringify({pruneEmpty,pruneCustom,described,channelEnglish,cliError,cliReady,gateway,data,network,stale,maintenance,sidebars,groups:navGroups,paths:navItems.map(item=>item.to)}));
    } finally {await server.close();}
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as {
    pruneEmpty: string; pruneCustom: string; described: string; channelEnglish: string; cliError: string; cliReady: string;
    gateway: Record<string, string>; data: string; network: string; stale: string;
    maintenance: Record<string, string>; sidebars: Record<string, string>; paths: string[];
    groups: { to: string; children: {to: string}[] }[];
  };
  expect(result.pruneEmpty).toMatch(/id="management-prune-provider"[^>]*value=""/u);
  expect(result.pruneEmpty).toMatch(/<button[^>]*disabled=""[^>]*>清理<\/button>/u);
  expect(result.pruneCustom).toMatch(/id="management-prune-provider"[^>]*value="custom-main"/u);
  const descriptionId = result.described.match(/aria-describedby="([^"]+)"/u)?.[1];
  expect(descriptionId).toBeTruthy();
  expect(result.described).toContain(`id="${descriptionId}">Capture scope`);
  expect(result.described).toContain('data-slot="field-content"');
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
    const html = result.sidebars[group.to]!;
    for (const child of group.children) expect(html).toContain(`href="${child.to}"`);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-current="page"');
  }
});
