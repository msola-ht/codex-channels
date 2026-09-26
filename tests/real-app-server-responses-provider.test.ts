import {validateModelCatalogWithCodex} from "../scripts/model-catalog-validation.mjs";
import { loadResponsesModelTemplates, responsesModelTemplatesFromCatalog } from "../scripts/responses-model-templates.mjs";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { SessionRouter } from "../src/session-routing/index.js";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { StdioTransport } from "../src/codex-client/stdio-transport.js";
import type { ModelListResponse, ThreadStartResponse, TurnStartResponse, ConfigReadResponse } from "../src/codex-protocol/index.js";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { createResponsesModelCatalog, writeResponsesModelCatalog, finishResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";
import { writeCustomPrimaryProviderSwitchingProfile, loadConfiguredCustomSwitchingModelProviders } from "../runtime/model-provider-runtime.mjs";
import { completedResponseEvent } from "./support/real-app-server-supervised-fixtures.js";
import { waitFor } from "./support/real-app-server-helpers.js";

const contract = process.env.RUN_CODEX_CONTRACT === "1" ? it : it.skip;
describe("real custom Responses provider", () => {
  contract("imports the real bundled official catalog including current reasoning levels", async () => {
    const models=await loadResponsesModelTemplates("official");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every(model=>!model.reasoningEfforts.includes("ultra") && !model.reasoningEfforts.includes("persistent"))).toBe(true);
  });
  contract("validates generated metadata against the native catalog contract before saving",async()=>{
    const definition={id:"test-model",name:"Test",contextWindow:64000,reasoningEfforts:[],defaultReasoningEffort:null,supportsImages:false};
    const source=createResponsesModelCatalog([definition],definition.id).models[0]!;
    await expect(validateModelCatalogWithCodex({models:[source]})).resolves.toBeUndefined();
    for(const patch of [{apply_patch_tool_type:"not-a-tool"},{support_verbosity:"yes"},{truncation_policy:undefined}]) {
      const snapshot=JSON.parse(JSON.stringify({...source,...patch})) as Record<string,unknown>;
      const catalog={models:[snapshot]};
      await expect(validateModelCatalogWithCodex(catalog)).rejects.toThrow("Codex CLI 校验");
    }
  });

  contract("isolates arbitrary model catalogs, sends declared capabilities and completes a tool round trip", async () => {
    const root = mkdtempSync(join(tmpdir(), "custom-responses-contract-"));
    const environment = { ...process.env, CODEX_HOME: join(root,"codex"), CODEX_CONNECT_HOME: join(root,"connect") };
    type RequestBody = { instructions?: string; text?: {verbosity?:string}; tools?: Array<{type:string;name?:string}>; model: string; reasoning: {effort?: string; summary?: string}; input: Array<{type:string; call_id?:string; output?:unknown}> };
    const bodies: RequestBody[] = [];
    const backend = createServer((request,response) => {
      const chunks: Buffer[]=[];request.on("data",(chunk:Buffer)=>chunks.push(chunk));
      request.on("end",()=>{
        if(request.url!=="/responses" || request.method!=="POST") {response.writeHead(404).end();return;}
        const body=JSON.parse(Buffer.concat(chunks).toString()) as RequestBody; bodies.push(body);
        const count=bodies.filter(entry=>entry.model===body.model).length;
        const id=`responses-${bodies.length}`;
        const item=count===1 ? {type:"function_call",id:`call-${id}`,call_id:`tool-${body.model}`,name:"exec_command",arguments:JSON.stringify({cmd:"printf custom-response-ok",login:false,max_output_tokens:100})} : {type:"message",role:"assistant",id:`answer-${id}`,content:[{type:"output_text",text:"Tool round trip complete"}]};
        response.writeHead(200,{"content-type":"text/event-stream"});
        const reasoning = { type: "reasoning", id: `thought-${id}`, summary: [], content: [{ type: "reasoning_text", text: `Full thought ${count}.` }] };
        for(const event of [{type:"response.created",response:{id}}, {type:"response.output_item.done",item:reasoning}, {type:"response.output_item.done",item},completedResponseEvent(id)]) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    let rpc:JsonRpcClient|undefined;
    try {
      await new Promise<void>(resolve=>backend.listen(0,"127.0.0.1",resolve));
      const address=backend.address();if(!address||typeof address==="string")throw new Error("Missing fixture listener");
      writePrivateFileAtomicSync(join(environment.CODEX_HOME,"config.toml"),'model_provider = "openai"\nmodel_reasoning_effort = "high"\n');
      for(const [id,model,reasoning] of [["rs-first","vendor/model-a",null],["rs-second","vendor/model-b","max"],["rs-template","vendor/ds-flash","high"]] as const) {
        const definition={id:model,name:model,contextWindow:64000,reasoningEfforts:reasoning===null?[]:[reasoning],defaultReasoningEffort:reasoning,supportsImages:false};
        const snapshot={...createResponsesModelCatalog([definition],model).models[0]!,slug:"deepseek-flash",max_context_window:1048576,
          model_messages:{instructions_template:"Complete DS fixture instructions. Use exec_command for commands."},
          shell_type:"shell_command",support_verbosity:true,default_verbosity:"low",apply_patch_tool_type:"freeform"};
        const imported=responsesModelTemplatesFromCatalog({models:[snapshot]},"deepseek")[0]!;
        const transaction=writeResponsesModelCatalog(environment,id,[id === "rs-template" ? {...imported,id:model} : definition],model);
        finishResponsesModelCatalogWrite(transaction);
        writeCustomPrimaryProviderSwitchingProfile({provider:id,model,name:"Custom Responses fixture",baseUrl:`http://127.0.0.1:${address.port}`,apiKey:"fixture-key",supportsWebsockets:false,catalogSource:{kind:"custom",reasoningEffort:reasoning}},environment);
      }
      for(const runtime of loadConfiguredCustomSwitchingModelProviders(environment)) {
        rpc=new JsonRpcClient(new StdioTransport({codexBinary:process.env.CODEX_BINARY??"codex",cwd:root,environment:{...environment,...runtime.childEnvironment},createCodexProcessInvocation:args=>({file:process.env.CODEX_BINARY??"codex",args:[...args,...runtime.arguments]})}),15000);
        const turns:Array<{id:string;status:string}>=[];
        rpc.onNotification(notification=>{if(notification.method==="turn/completed") turns.push((notification.params as {turn:{id:string;status:string}}).turn);});
        rpc.setServerRequestHandler(async()=>{throw new Error("Unexpected privileged request");});
        await rpc.connect();
        const config=await rpc.request<ConfigReadResponse>({method:"config/read",params:{includeLayers:false}});
        expect(config.config.model_provider).toBe(runtime.id);
        const listed=await rpc.request<ModelListResponse>({method:"model/list",params:{}});
        expect(listed.data.map(model=>model.model)).toEqual([runtime.model]);
        const client = new CodexAppServerClient(rpc, {sandbox:"read-only"});
        const selection = new ModelSelectionService({
          listModels: async () => [],
          listModelsForProvider: async provider => {
            expect(provider).toBe(runtime.id);
            return client.listModels();
          },
          writeDefaultFastMode: async () => undefined,
          readDefaultReasoningEffort: async () => null,
          readDefaultServiceTier: async () => null,
        }, {current:()=>undefined,modelSettings:()=>undefined} as unknown as SessionRouter,
        undefined, [], "openai", [], () => false, undefined, undefined,
        [{provider:runtime.id,displayName:runtime.name,defaultModel:runtime.model}]);
        const target = {surface:"telegram" as const,accountId:"fixture",conversationId:"fixture"};
        expect((await selection.browseProvider(target,runtime.id)).models.map(model=>model.model)).toEqual([runtime.model]);
        await selection.selectModel(target,{provider:runtime.id,model:runtime.model});
        const selected = selection.threadStartOptions(target);
        expect(selected).toMatchObject({modelProvider:runtime.id,model:runtime.model});
        if (!selected.model || !selected.modelProvider) throw new Error("RS selection missing");
        const {thread}=await rpc.request<ThreadStartResponse>({method:"thread/start",params:{cwd:root,model:selected.model,modelProvider:selected.modelProvider,sandbox:"read-only",approvalPolicy:"never",ephemeral:true}});
        expect(thread.modelProvider).toBe(runtime.id);
        const {turn}=await rpc.request<TurnStartResponse>({method:"turn/start",params:{threadId:thread.id,input:[{type:"text",text:"Run the fixture command",text_elements:[]}]}});
        await waitFor(()=>turns.some(entry=>entry.id===turn.id),15000);
        expect(turns).toContainEqual(expect.objectContaining({id:turn.id,status:"completed"}));
        const requests=bodies.filter(body=>body.model===runtime.model);
        expect(requests).toHaveLength(2);
        if (runtime.id === "rs-template") {
          expect(requests[0]?.instructions).not.toContain("Complete DS fixture instructions");
          expect(requests[0]?.instructions).toContain("You are a coding assistant");
          expect(requests[0]?.text?.verbosity).toBeUndefined();
          expect(requests[0]?.tools).not.toContainEqual(expect.objectContaining({name:"apply_patch",type:"custom"}));
        }
        expect(requests[0]?.reasoning).toEqual({effort:runtime.reasoningEffort});
        expect(requests[1]?.input).toContainEqual(expect.objectContaining({type:"function_call_output",call_id:`tool-${runtime.model}`,output:expect.stringContaining("custom-response-ok")}));
        expect(requests[1]?.input).toContainEqual(expect.objectContaining({ type: "reasoning", content: [{ type: "reasoning_text", text: "Full thought 1." }] }));
        const next = await rpc.request<TurnStartResponse>({ method: "turn/start", params: { threadId: thread.id, input: [{ type: "text", text: "Continue", text_elements: [] }] } });
        await waitFor(() => turns.some(entry => entry.id === next.turn.id), 15000);
        expect(turns).toContainEqual(expect.objectContaining({ id: next.turn.id, status: "completed" }));
        const nextRequest = bodies.filter(body => body.model === runtime.model)[2];
        for (const count of [1, 2]) expect(nextRequest?.input).toContainEqual(expect.objectContaining({ type: "reasoning", content: [{ type: "reasoning_text", text: `Full thought ${count}.` }] }));
        await rpc.close();rpc=undefined;
      }
    } finally {
      await rpc?.close();backend.closeAllConnections();await new Promise<void>(resolve=>backend.close(()=>resolve()));
      rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    }
  },30000);
});
