import { normalizeDeepseekCatalogCapabilities } from "../scripts/deepseek-setup.mjs";
import {validateModelCatalogWithCodex} from "../scripts/model-catalog-validation.mjs";
import { loadResponsesModelTemplates, responsesModelTemplatesFromCatalog } from "../scripts/responses-model-templates.mjs";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stringify } from "smol-toml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { SessionRouter } from "../src/session-routing/index.js";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { StdioTransport } from "../src/codex-client/stdio-transport.js";
import { toAutoApprovalReviewEvent, type AutoApprovalReviewEvent } from "../src/codex-client/index.js";
import { AutoApprovalReviewNotifications } from "../src/bootstrap/auto-approval-review-notifications.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { ProviderProxy, type ProviderProxyMetrics } from "../src/provider-proxy/index.js";
import type { ModelListResponse, ThreadStartResponse, TurnStartResponse, ConfigReadResponse, ServerNotification } from "../src/codex-protocol/index.js";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { createResponsesModelCatalog, writeResponsesModelCatalog, finishResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";
import { writeCustomPrimaryProviderSwitchingProfile, loadConfiguredCustomSwitchingModelProviders, loadManagedProviderAppServers } from "../runtime/model-provider-runtime.mjs";
import { deepseekAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderProfile } from "../runtime/model-provider-profile.mjs";
import { completedResponseEvent } from "./support/real-app-server-supervised-fixtures.js";
import { waitFor } from "./support/real-app-server-helpers.js";

const contract = process.env.RUN_CODEX_CONTRACT === "1" ? it : it.skip;
describe("real custom Responses provider", () => {
  for (const outcome of ["allow", "deny"] as const) {
    contract(`emits real agent auto-review lifecycle and enforces ${outcome}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "responses-auto-review-"));
      const environment = { ...process.env, CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
      type RequestBody = {
        model: string;
        client_metadata?: Record<string, string>;
        input: Array<{ type: string; call_id?: string; output?: unknown }>;
      };
      const parentRequests: RequestBody[] = [];
      const reviewerRequests: RequestBody[] = [];
      const command = "printf auto-review-executed > auto-review-result";
      const callId = `auto-review-${outcome}-command`;
      const backend = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.url !== "/responses" || request.method !== "POST") { response.writeHead(404).end(); return; }
          const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
          const guardian = body.client_metadata?.["x-openai-subagent"] === "guardian";
          (guardian ? reviewerRequests : parentRequests).push(body);
          const id = guardian ? `review-${outcome}` : `parent-${parentRequests.length}`;
          const assessment = JSON.stringify({ risk_level: outcome === "allow" ? "low" : "high",
            user_authorization: outcome === "allow" ? "high" : "unknown", outcome, rationale: "fixture" });
          const item = !guardian && parentRequests.length === 1
            ? { type: "function_call", id: callId, call_id: callId, name: "exec_command",
              arguments: JSON.stringify({ cmd: command, login: false, max_output_tokens: 100,
                sandbox_permissions: "require_escalated", justification: "Run the isolated contract fixture command" }) }
            : { type: "message", role: "assistant", id: `message-${id}`,
              content: [{ type: "output_text", text: guardian ? assessment : "Auto-review fixture complete" }] };
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of [{ type: "response.created", response: { id } },
            { type: "response.output_item.done", item }, completedResponseEvent(id)]) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end();
        });
      });
      type ReviewStarted = Extract<ServerNotification, { method: "item/autoApprovalReview/started" }>["params"];
      type ReviewCompleted = Extract<ServerNotification, { method: "item/autoApprovalReview/completed" }>["params"];
      const started: ReviewStarted[] = [];
      const completed: ReviewCompleted[] = [];
      const turns: Array<{ id: string; status: string }> = [];
      const privilegedRequests: string[] = [];
      const projectedReviews: AutoApprovalReviewEvent[] = [];
      const channelReviews: OutputEvent[] = [];
      let boundThreadId: string | undefined;
      const notifications = new AutoApprovalReviewNotifications({
        targetForThread: threadId => threadId === boundThreadId
          ? { surface: "telegram", accountId: "fixture", conversationId: "fixture-chat" } : undefined,
        isBackgroundThread: () => false, providerForThread: () => "fixture",
        publish: event => { channelReviews.push(event); },
        unroutable: () => { throw new Error("Unexpected unroutable auto-review"); },
      });
      const metricsPath = join(root, "metrics.sqlite3");
      let metricsStore: SqliteModelRequestMetricsStore | undefined;
      let rpc: JsonRpcClient | undefined;
      try {
        await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
        const address = backend.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture listener");
        const catalogPath = join(environment.CODEX_HOME, "fixture-models.json");
        writePrivateFileAtomicSync(catalogPath, JSON.stringify(createResponsesModelCatalog([{
          id: "fixture-model", name: "Auto-review fixture", contextWindow: 64000,
          reasoningEfforts: [], defaultReasoningEffort: null, supportsImages: false,
        }], "fixture-model")));
        writePrivateFileAtomicSync(join(environment.CODEX_HOME, "config.toml"), stringify({
          model: "fixture-model", model_provider: "fixture", model_catalog_json: catalogPath,
          approval_policy: "on-request", approvals_reviewer: "auto_review", web_search: "disabled",
          features: { guardian_approval: true, guardianv2: { enabled: false } },
          model_providers: { fixture: { name: "Auto-review fixture", base_url: `http://127.0.0.1:${address.port}`,
            wire_api: "responses", requires_openai_auth: false, supports_websockets: false,
            request_max_retries: 0, stream_max_retries: 0 } },
        }));
        metricsStore = new SqliteModelRequestMetricsStore(metricsPath);
        rpc = new JsonRpcClient(new StdioTransport({ codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: root, environment }), 15000);
        rpc.onNotification(notification => {
          const projected = toAutoApprovalReviewEvent(notification);
          if (projected) {
            projectedReviews.push(projected);
            notifications.handle(projected);
            metricsStore!.recordAutoApprovalReview(projected, "fixture");
          }
          if (notification.method === "turn/started" || notification.method === "turn/completed") {
            const params = notification.params as { threadId: string; turn: { id: string } };
            metricsStore!.observeAutoApprovalTurn(params.threadId, params.turn.id, "fixture",
              notification.method === "turn/started" ? "started" : "completed");
          }
          if (notification.method === "item/autoApprovalReview/started") started.push(notification.params as ReviewStarted);
          if (notification.method === "item/autoApprovalReview/completed") completed.push(notification.params as ReviewCompleted);
          if (notification.method === "turn/completed") turns.push((notification.params as { turn: { id: string; status: string } }).turn);
        });
        rpc.setServerRequestHandler(async request => {
          privilegedRequests.push(request.method);
          throw new Error("Unexpected privileged request");
        });
        await rpc.connect();
        const { thread } = await rpc.request<ThreadStartResponse>({ method: "thread/start", params: {
          cwd: root, model: "fixture-model", modelProvider: "fixture", sandbox: "read-only",
          approvalPolicy: "on-request", approvalsReviewer: "auto_review", ephemeral: true,
        } });
        boundThreadId = thread.id;
        const { turn } = await rpc.request<TurnStartResponse>({ method: "turn/start", params: {
          threadId: thread.id, input: [{ type: "text", text: "Run the isolated fixture command", text_elements: [] }],
        } });
        await waitFor(() => turns.some(value => value.id === turn.id), 15000);
        expect(turns).toContainEqual(expect.objectContaining({ id: turn.id, status: "completed" }));
        expect(privilegedRequests).toEqual([]);
        expect(reviewerRequests).toHaveLength(1);
        expect(parentRequests).toHaveLength(2);
        expect(started).toHaveLength(1);
        expect(completed).toHaveLength(1);
        const reviewStarted = started[0]!;
        const reviewCompleted = completed[0]!;
        expect(reviewStarted).toMatchObject({ threadId: thread.id, turnId: turn.id, targetItemId: callId,
          review: { status: "inProgress" }, action: { type: "command", command: expect.stringContaining(command), cwd: root } });
        expect(reviewStarted.reviewId).not.toBe("");
        expect(reviewCompleted).toMatchObject({ threadId: thread.id, turnId: turn.id, targetItemId: callId,
          reviewId: reviewStarted.reviewId, startedAtMs: reviewStarted.startedAtMs, decisionSource: "agent",
          review: { status: outcome === "allow" ? "approved" : "denied", rationale: "fixture" },
          action: reviewStarted.action });
        expect(reviewCompleted.completedAtMs).toBeGreaterThanOrEqual(reviewStarted.startedAtMs);
        expect(projectedReviews).toEqual([
          { threadId: thread.id, turnId: turn.id, reviewId: reviewStarted.reviewId, phase: "started", status: "inProgress", approved: false },
          { threadId: thread.id, turnId: turn.id, reviewId: reviewStarted.reviewId, phase: "completed", status: outcome === "allow" ? "approved" : "denied", approved: outcome === "allow" },
        ]);
        expect(channelReviews).toEqual(projectedReviews.map(value => ({
          type: "autoApprovalReview.updated", target: { surface: "telegram", accountId: "fixture", conversationId: "fixture-chat" },
          threadId: thread.id, turnId: turn.id, sourceThreadId: thread.id, sourceTurnId: turn.id,
          reviewId: value.reviewId, phase: value.phase, status: value.status,
        })));
        expect(JSON.stringify(channelReviews)).not.toContain(command);
        expect(channelReviews.some(event => "action" in event || "rationale" in event)).toBe(false);
        expect(metricsStore.taskAutoApprovalReviewSummary(thread.id, turn.id)).toEqual({
          approved: outcome === "allow" ? 1 : 0, coverage: "complete",
        });
        const toolOutput = parentRequests[1]?.input.find(item => item.type === "function_call_output" && item.call_id === callId);
        expect(toolOutput).toBeDefined();
        const resultPath = join(root, "auto-review-result");
        if (outcome === "allow") {
          expect(readFileSync(resultPath, "utf8")).toBe("auto-review-executed");
          expect(toolOutput?.output).toEqual(expect.stringContaining("Process exited with code 0"));
        } else {
          expect(existsSync(resultPath)).toBe(false);
          expect(toolOutput?.output).toEqual(expect.stringMatching(/reject|denied/iu));
        }
        await rpc.close();
        metricsStore.close();
        metricsStore = new SqliteModelRequestMetricsStore(metricsPath);
        expect(metricsStore.taskAutoApprovalReviewSummary(thread.id, turn.id)).toEqual({
          approved: outcome === "allow" ? 1 : 0, coverage: "partial",
        });
      } finally {
        await rpc?.close();
        metricsStore?.close();
        backend.closeAllConnections();
        await new Promise<void>(resolve => backend.close(() => resolve()));
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 30000);
  }

  contract("completes a real WebSocket turn when upstream closes before metrics acknowledgement", async () => {
    const root = mkdtempSync(join(tmpdir(), "responses-ws-contract-"));
    const environment = { ...process.env, CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
    let httpRequests = 0;
    let modelRequests = 0;
    let upstreamClosed = false;
    const backend = createServer((request, response) => { httpRequests++; request.resume(); response.writeHead(501).end(); });
    const sockets = new WebSocketServer({ server: backend });
    sockets.on("connection", socket => {
      socket.on("message", data => {
        const body = JSON.parse(data.toString()) as { generate?: boolean };
        const id = body.generate === false ? "warmup" : "fixture-response";
        socket.send(JSON.stringify({ type: "response.created", response: { id } }));
        if (body.generate === false) { socket.send(JSON.stringify(completedResponseEvent(id))); return; }
        modelRequests++;
        socket.once("close", () => { upstreamClosed = true; });
        socket.send(JSON.stringify({ type: "response.output_item.done", item: {
          type: "message", role: "assistant", id: "fixture-message", content: [{ type: "output_text", text: "WebSocket complete" }],
        } }));
        socket.send(JSON.stringify(completedResponseEvent(id)), () => socket.close());
      });
    });
    const metrics: ProviderProxyMetrics[] = [];
    let acknowledge: (() => void) | undefined;
    let proxy: ProviderProxy | undefined;
    let rpc: JsonRpcClient | undefined;
    try {
      await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
      const address = backend.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture listener");
      proxy = new ProviderProxy("127.0.0.1:0", { upstreamHost: "127.0.0.1", upstreamPort: address.port, upstreamProtocol: "http",
        onMetrics: metric => { metrics.push(metric); return new Promise<void>(resolve => { acknowledge = resolve; }); } });
      await proxy.start();
      writePrivateFileAtomicSync(join(environment.CODEX_HOME, "config.toml"), stringify({
        model: "fixture-model", model_provider: "fixture", web_search: "disabled",
        model_providers: { fixture: { name: "WebSocket fixture", base_url: `http://${proxy.address()}`,
          wire_api: "responses", requires_openai_auth: false, supports_websockets: true, request_max_retries: 0, stream_max_retries: 0 } },
      }));
      rpc = new JsonRpcClient(new StdioTransport({ codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: root, environment }), 15000);
      const turns: Array<{ id: string; status: string }> = [];
      rpc.onNotification(notification => {
        if (notification.method === "turn/completed") turns.push((notification.params as { turn: { id: string; status: string } }).turn);
      });
      rpc.setServerRequestHandler(async () => { throw new Error("Unexpected privileged request"); });
      await rpc.connect();
      const { thread } = await rpc.request<ThreadStartResponse>({ method: "thread/start", params: {
        cwd: root, model: "fixture-model", modelProvider: "fixture", sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
      } });
      const { turn } = await rpc.request<TurnStartResponse>({ method: "turn/start", params: {
        threadId: thread.id, input: [{ type: "text", text: "Say hello", text_elements: [] }],
      } });
      await waitFor(() => metrics.length === 1 && upstreamClosed, 10000);
      acknowledge?.();
      await waitFor(() => turns.some(value => value.id === turn.id), 10000);
      expect(turns).toContainEqual(expect.objectContaining({ id: turn.id, status: "completed" }));
      expect(metrics).toEqual([expect.objectContaining({ transport: "websocket", status: "completed", threadId: thread.id, turnId: turn.id })]);
      expect(modelRequests).toBe(1);
      expect(httpRequests).toBe(0);
    } finally {
      acknowledge?.();
      await rpc?.close();
      await proxy?.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      backend.closeAllConnections();
      await new Promise<void>(resolve => backend.close(() => resolve()));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);

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
      writePrivateFileAtomicSync(join(environment.CODEX_HOME,"config.toml"),'model_provider = "openai"\nmodel_reasoning_effort = "high"\nweb_search = "live"\n');
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
      const ds = deepseekAccountDefinition("test");
      const dsDirectory = join(environment.CODEX_CONNECT_HOME, "providers", "deepseek");
      const dsCatalogPath = join(dsDirectory, "models.json");
      const dsSourceCatalog = createResponsesModelCatalog([{id:"deepseek-flash",name:"DS fixture",contextWindow:64000,reasoningEfforts:["high"],defaultReasoningEffort:"high",supportsImages:false,applyPatchToolType:"freeform",supportsSearchTool:true}], "deepseek-flash");
      Object.assign(dsSourceCatalog.models[0]!, { support_verbosity: true, default_verbosity: "low", supports_reasoning_summary_parameter: true, default_reasoning_summary: "detailed" });
      const dsCatalog = normalizeDeepseekCatalogCapabilities(dsSourceCatalog);
      writePrivateFileAtomicSync(dsCatalogPath, JSON.stringify(dsCatalog));
      writePrivateFileAtomicSync(join(dsDirectory,"accounts.json"), JSON.stringify([{id:"test",default:true}]));
      writePrivateFileAtomicSync(join(dsDirectory,"accounts","test","managed.toml"), 'version = 1\nprovider = "ds-test"\nmode = "switching"\n');
      writePrivateFileAtomicSync(join(environment.CODEX_HOME,ds.profileFileName), stringify(createManagedProviderProfile(ds,{apiKey:"sk-fixture",catalogPath:dsCatalogPath})));
      const dsRuntime = loadManagedProviderAppServers(environment)[0]!;
      // Override the endpoint and request unsupported controls to verify the narrowed catalog.
      dsRuntime.arguments.push("-c", `model_providers.ds-test.base_url="http://127.0.0.1:${address.port}"`,
        "-c", 'model_reasoning_summary="detailed"', "-c", 'model_verbosity="high"');
      for(const runtime of [...loadConfiguredCustomSwitchingModelProviders(environment), {...dsRuntime,id:dsRuntime.provider,name:"DS fixture",model:"deepseek-flash",reasoningEffort:"high"}]) {
        rpc=new JsonRpcClient(new StdioTransport({codexBinary:process.env.CODEX_BINARY??"codex",cwd:root,environment:{...environment,...runtime.childEnvironment},createCodexProcessInvocation:args=>({file:process.env.CODEX_BINARY??"codex",args:[...args,...runtime.arguments]})}),15000);
        const turns:Array<{id:string;status:string}>=[];
        rpc.onNotification(notification=>{if(notification.method==="turn/completed") turns.push((notification.params as {turn:{id:string;status:string}}).turn);});
        rpc.setServerRequestHandler(async()=>{throw new Error("Unexpected privileged request");});
        await rpc.connect();
        const config=await rpc.request<ConfigReadResponse>({method:"config/read",params:{includeLayers:false}});
        expect(config.config.model_provider).toBe(runtime.id);
        expect(config.config.web_search).toBe("disabled");
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
        for (const request of requests) expect(request.tools).not.toContainEqual(expect.objectContaining({type:"web_search"}));
        if (runtime.id === "ds-test") {
          expect(requests[0]?.tools).toContainEqual(expect.objectContaining({type:"custom",name:"apply_patch"}));
          expect(requests[0]?.text?.verbosity).toBeUndefined();
          expect(requests[0]?.reasoning.summary).toBeUndefined();
          expect(JSON.parse(readFileSync(dsCatalogPath,"utf8")).models[0].supports_search_tool).toBe(true);
          expect(readFileSync(join(environment.CODEX_HOME,"config.toml"),"utf8")).toContain('web_search = "live"');
        }
        if (runtime.id === "rs-template") {
          expect(requests[0]?.instructions).toBe("Complete DS fixture instructions. Use exec_command for commands.");
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
