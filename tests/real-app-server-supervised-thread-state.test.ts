import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { toConversationInputEvent, toThreadStateEvent } from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { GatewayApplication } from "../src/bootstrap/app.js";
import { withOutputExecutionAdmission } from "../src/bootstrap/output-execution-admission.js";
import { ConversationService, type ConversationQueryPort } from "../src/application/conversation-service.js";
import { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { ThreadApprovalsReviewerPort } from "../src/application/turn-port.js";
import { ConversationCore, type OutputEvent } from "../src/conversation-core/index.js";
import { EventBus } from "../src/event-bus/index.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";
import { WorkspaceRegistry } from "../src/policy/index.js";
import { SessionRouter, ThreadStateSynchronizer } from "../src/session-routing/index.js";
import { appendDiagnostic, appServerFailure, stopDetachedTestProcess, waitFor } from "./support/real-app-server-helpers.js";
import { secureTestDirectory } from "./support/windows-fixtures.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;

contractSuite("real supervised App Server thread-state", () => {
    it("runs confirmed reviewer updates, restored task management, paginated history, active-turn Revert and preserved Queue against local Responses", async () => {
      const testRuntime = mkdtempSync(join(tmpdir(), "codex-revert-contract-"));
      secureTestDirectory(testRuntime);
      const codexHome = join(testRuntime, "codex-home");
      const workspace = join(testRuntime, "workspace");
      const socketPath = join(testRuntime, "codex-app-server.sock");
      const apiServerResponses = new Map<ServerResponse, string>();
      const responseIds: string[] = [];
      const requestBodies: string[] = [];
      const apiServer = createServer((request, response) => {
        if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            object: "list",
            data: [{ id: "revert-contract-model", object: "model", owned_by: "contract" }],
          }));
          return;
        }
        if (request.method === "POST" && request.url === "/v1/responses") {
          request.setEncoding("utf8");
          let body = "";
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            requestBodies.push(body);
            response.writeHead(200, { "content-type": "text/event-stream" });
            const responseId = `revert-contract-response-${responseIds.length + 1}`;
            responseIds.push(responseId);
            response.write(`data: ${JSON.stringify({
              type: "response.created",
              response: { id: responseId },
            })}\n\n`);
            apiServerResponses.set(response, responseId);
            response.once("close", () => apiServerResponses.delete(response));
          });
          return;
        }
        request.resume();
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "revert contract fixture endpoint" } }));
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        apiServer.once("error", rejectListen);
        apiServer.listen(0, "127.0.0.1", () => resolveListen());
      });
      const apiAddress = apiServer.address();
      if (!apiAddress || typeof apiAddress === "string") {
        throw new Error("Revert 合同无法创建本机 Responses 夹具");
      }
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      writeFileSync(join(codexHome, "config.toml"), [
        'model = "revert-contract-model"',
        'model_provider = "revert-contract"',
        'approvals_reviewer = "auto_review"',
        "thread_unload_delay_secs = 0",
        "",
        "[model_providers.revert-contract]",
        'name = "Revert Contract Provider"',
        `base_url = "http://127.0.0.1:${apiAddress.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "supports_websockets = false",
        "",
      ].join("\n"), { mode: 0o600 });

      let stderr = "";
      const processHandle = spawn(
        process.env.CODEX_BINARY ?? "codex",
        ["app-server", "--listen", `unix://${socketPath}`],
        {
          cwd: process.cwd(),
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ["ignore", "ignore", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      processHandle.stderr?.setEncoding("utf8");
      processHandle.stderr?.on("data", (chunk: string) => {
        stderr = appendDiagnostic(stderr, chunk);
      });
      let client: CodexAppServerClient | undefined;
      let threadId: string | undefined;
      const completedStatuses = new Map<string, string>();
      const revertedThreadIds: string[] = [];
      const observedReviewers: Array<string | null | undefined> = [];
      let removeNotification: (() => void) | undefined;
      let removeGateNotification: (() => void) | undefined;
      let gateInbound: EventBus<Parameters<typeof toThreadStateEvent>[0]> | undefined;
      let gateOutput: EventBus<OutputEvent> | undefined;
      const completeResponse = (responseId: string): void => {
        const response = [...apiServerResponses.entries()]
          .find(([, id]) => id === responseId)?.[0];
        if (!response) {
          throw new Error(`找不到待完成的 Revert Responses 夹具：${responseId}`);
        }
        response.write(`data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: responseId,
            status: "completed",
            usage: {
              input_tokens: 1,
              input_tokens_details: null,
              output_tokens: 1,
              output_tokens_details: null,
              total_tokens: 2,
            },
          },
        })}\n\n`);
        response.end();
      };
      const startCompletedTurn = async (text: string, index: number): Promise<string> => {
        const started = await client!.startTurn(
          threadId!,
          [{ type: "text", text }],
          `codex_connect:revert-contract-${index}`,
          workspace,
        );
        await waitFor(() => responseIds.length > index, 5_000);
        completeResponse(responseIds[index]!);
        await waitFor(() => completedStatuses.get(started.turnId) === "completed", 10_000);
        return started.turnId;
      };
      try {
        await waitFor(
          () => existsSync(socketPath),
          10_000,
          () => processHandle.exitCode === null
            ? undefined
            : new Error(appServerFailure("Revert 合同 App Server 启动失败", stderr)),
        );
        const rpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
        client = new CodexAppServerClient(
          rpc,
          { sandbox: "workspace-write" },
        );
        await client.connect();
        const started = await client.startThread(workspace);
        threadId = started.thread.id;
        expect(started.thread.historyMode).toBe("paginated");
        expect(started.approvalsReviewer).toBe("auto_review");
        removeNotification = client.onNotification((notification) => {
          const state = toThreadStateEvent(notification);
          if (state?.type === "thread.settings.updated" && state.threadId === threadId) {
            observedReviewers.push(state.settings.approvalsReviewer);
          }
          const event = toConversationInputEvent(notification);
          if (event?.type === "turn.completed") {
            completedStatuses.set(event.turnId, event.status);
          }
          if (event?.type === "thread.reverted") revertedThreadIds.push(event.threadId);
        });

        const firstTurnId = await startCompletedTurn("first revert turn", 0);
        expect((await client.resumeThread(threadId, workspace)).approvalsReviewer).toBe("auto_review");
        const turnsBeforeReviewerUpdate = await client.listThreadTurns(threadId);
        await client.updateThreadApprovalsReviewer(threadId, "user");
        expect(observedReviewers).toContain("user");
        expect(await client.listThreadTurns(threadId)).toEqual(turnsBeforeReviewerUpdate);
        expect((await client.resumeThread(threadId, workspace)).approvalsReviewer).toBe("user");
        const manual = await client.startThread(workspace, { approvalsReviewer: "user", ephemeral: true });
        expect(manual.approvalsReviewer).toBe("user");
        await client.unsubscribeThread(manual.thread.id);
        const forked = await client.forkThread(threadId, workspace, { approvalsReviewer: "auto_review" });
        expect(forked.approvalsReviewer).toBe("auto_review");
        await client.unsubscribeThread(forked.thread.id);
        const loaded = await client.resumeThread(threadId, workspace, { approvalsReviewer: "auto_review" });
        expect(loaded.approvalsReviewer).toBe("user");
        expect(loaded.settingsMatch).toBe(false);
        for (const approvalsReviewer of ["auto_review", "user"] as const) {
          await client.unsubscribeThread(threadId);
          await expect.poll(async () => (await client!.readThread(threadId!)).status.type, { timeout: 5_000 }).toBe("notLoaded");
          const resumed = await client.resumeThread(threadId, workspace, { approvalsReviewer });
          expect(resumed.approvalsReviewer).toBe(approvalsReviewer);
          expect(resumed.settingsMatch).toBe(true);
        }
        expect((await client.resumeThread(threadId, workspace)).approvalsReviewer).toBe("user");
        const bindings = new MemoryBindingStore();
        const workspaces = new WorkspaceRegistry([{ id: "contract", name: "Contract", cwd: workspace, approvalsReviewer: "auto_review" }], "contract");
        const router = new SessionRouter(client, bindings, workspaces, [], undefined, {
          primaryProvider: "revert-contract", supportedProviders: new Set(),
        });
        const gatewayTarget = { surface: "telegram" as const, accountId: "contract", conversationId: "contract" };
        let synchronizer = new ThreadStateSynchronizer(router);
        gateOutput = new EventBus<OutputEvent>(pino({ level: "silent" }));
        let restoredCore = new ConversationCore(router, gateOutput);
        gateInbound = new EventBus(pino({ level: "silent" }));
        gateInbound.subscribe("routing", notification => {
          const state = toThreadStateEvent(notification);
          if (state) synchronizer.handle(state);
          const input = toConversationInputEvent(notification);
          if (input) restoredCore.handle(input);
        });
        removeGateNotification = client.onNotification(notification => gateInbound!.publish(notification, true));
        const admission = Object.assign(Object.create(GatewayApplication.prototype), {
          codex: client, inbound: gateInbound, bindings, workspaces, router,
          interactions: { hasPendingForThread: () => false }, stopping: false,
          core: restoredCore,
        }) as ThreadApprovalsReviewerPort & {
          admitThreadApprovalsReviewer(id: string): Promise<void>;
          router: SessionRouter;
          core: Pick<ConversationCore, "activeTurnForThread">;
        };
        await client.updateThreadApprovalsReviewer(threadId, "auto_review");
        const unchangedHistory = await client.listThreadTurns(threadId);
        await router.resume(gatewayTarget, threadId);
        expect(router.modelSettingsForThread(threadId)?.approvalsReviewer).toBe("auto_review");
        await admission.admitThreadApprovalsReviewer(threadId);
        expect(router.modelSettingsForThread(threadId)?.approvalsReviewer).toBe("user");
        expect(await client.listThreadTurns(threadId)).toEqual(unchangedHistory);
        await client.updateThreadApprovalsReviewer(threadId, "auto_review");
        await client.unsubscribeThread(threadId);
        await expect.poll(async () => (await client!.readThread(threadId!)).status.type, { timeout: 5_000 }).toBe("notLoaded");
        await router.resume(gatewayTarget, threadId);
        expect(router.modelSettingsForThread(threadId)?.approvalsReviewer).toBe("user");
        expect((await client.resumeThread(threadId, workspace)).approvalsReviewer).toBe("user");
        const gatewayFork = await router.fork(gatewayTarget);
        expect((await client.resumeThread(gatewayFork.threadId, workspace)).approvalsReviewer).toBe("user");
        await router.resume(gatewayTarget, threadId);
        const background = await router.startBackground(gatewayTarget, { approvalPolicy: "never" });
        expect(background.session.approvalsReviewer).toBe("user");
        await client.unsubscribeThread(background.binding.threadId);
        // A settings write bypassing Gateway is received through the real shared
        // notification reducer, then confirmed back to user before admission.
        await client.updateThreadApprovalsReviewer(threadId, "auto_review");
        await admission.admitThreadApprovalsReviewer(threadId);
        expect(router.modelSettingsForThread(threadId)?.approvalsReviewer).toBe("user");
        expect((await client.resumeThread(threadId, workspace)).approvalsReviewer).toBe("user");
        expect(await client.listThreadTurns(threadId)).toEqual(unchangedHistory);
        const secondTurnId = await startCompletedTurn("second revert turn", 1);
        const listed = await client.listThreadTurns(threadId, { limit: 25 });
        expect(listed.turns.map((turn) => turn.id)).toEqual([secondTurnId, firstTurnId]);
        expect(listed.turns[0]).toMatchObject({ inputType: "text", textPreview: "second revert turn" });

        const active = await client.startTurn(
          threadId,
          [{ type: "text", text: "active revert turn" }],
          "codex_connect:revert-contract-active",
          workspace,
        );
        await waitFor(() => responseIds.length > 2, 5_000);
        await client.updateThreadApprovalsReviewer(threadId, "auto_review");
        await expect(admission.admitThreadApprovalsReviewer(threadId)).rejects.toMatchObject({ code: "autoreview.execution-blocked" });
        expect((await client.readThread(threadId)).status.type).toBe("active");
        expect(completedStatuses.has(active.turnId)).toBe(false);
        expect((await client.resumeThread(threadId, workspace)).approvalsReviewer).toBe("auto_review");
        await client.updateThreadApprovalsReviewer(threadId, "user");
        const queuedFirst = await client.addQueueItem(
          threadId,
          "queued first after revert",
          "codex_connect:revert-queue-first",
        );
        const queuedSecond = await client.addQueueItem(
          threadId,
          "queued second after revert",
          "codex_connect:revert-queue-second",
        );
        expect((await client.listQueue(threadId, { limit: 100 })).items.map((item) => item.id))
          .toEqual([queuedFirst.id, queuedSecond.id]);
        const activeReverted = await client.revertThread(threadId, active.turnId);
        expect(activeReverted.thread).toMatchObject({ id: threadId, historyMode: "paginated" });
        expect(completedStatuses.get(active.turnId)).toBe("interrupted");
        await waitFor(() => revertedThreadIds.includes(threadId!), 5_000);
        expect((await client.listQueue(threadId, { limit: 100 })).items.map((item) => item.id))
          .toEqual([queuedFirst.id, queuedSecond.id]);
        await client.startQueueItem(threadId);
        await waitFor(() => requestBodies.length > 3, 5_000);
        expect(requestBodies[3]).toContain("queued first after revert");
        expect(requestBodies[3]).not.toContain("queued second after revert");
        completeResponse(responseIds[3]!);
        await waitFor(() => requestBodies.length > 4, 10_000);
        expect(requestBodies[4]).toContain("queued second after revert");
        completeResponse(responseIds[4]!);
        await waitFor(
          () => [...completedStatuses.values()].filter((status) => status === "completed").length >= 4,
          10_000,
        );
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(0);
        const afterQueuedDispatch = await client.listThreadTurns(threadId, { limit: 25 });
        expect(afterQueuedDispatch.turns.map((turn) => turn.textPreview)).toEqual([
          "queued second after revert",
          "queued first after revert",
          "second revert turn",
          "first revert turn",
        ]);
        expect(afterQueuedDispatch.turns.slice(-2).map((turn) => turn.id)).toEqual([
          secondTurnId,
          firstTurnId,
        ]);

        await client.revertThread(threadId, secondTurnId);
        await waitFor(() => revertedThreadIds.length >= 2, 5_000);
        expect((await client.listThreadTurns(threadId, { limit: 25 })).turns.map((turn) => turn.id))
          .toEqual([firstTurnId]);
        await expect(client.revertThread(threadId, "missing-turn")).rejects.toThrow("turn not found");

        // Restore a running unsupported Thread into fresh Router/Core state,
        // as on Gateway restart. Resume restores management independently of
        // whether another Gateway input can pass the execution gate.
        await client.updateThreadApprovalsReviewer(threadId, "auto_review");
        const recoveringTurn = await client.startTurn(threadId,
          [{ type: "text", text: "running task during Gateway recovery" }],
          "codex_connect:reviewer-recovery", workspace);
        await waitFor(() => responseIds.length > 5, 5_000);
        await client.unsubscribeThread(threadId);
        expect((await client.readThread(threadId)).status.type).toBe("active");
        const managementRouter = new SessionRouter(client, bindings, workspaces, [], undefined, {
          primaryProvider: "revert-contract", supportedProviders: new Set(),
        });
        restoredCore = new ConversationCore(managementRouter, gateOutput);
        synchronizer = new ThreadStateSynchronizer(managementRouter);
        admission.router = managementRouter;
        admission.core = restoredCore;
        const execution = withOutputExecutionAdmission(client,
          id => admission.admitThreadApprovalsReviewer(id));
        const service = new ConversationService(execution, managementRouter, restoredCore,
          new ModelSelectionService(client, managementRouter), {} as ConversationQueryPort,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          undefined, admission);
        const restoreRunningBinding = () => managementRouter.restoreSubscriptions(
          (_target, binding) => binding.threadId === threadId, (binding, snapshot) => {
            if (snapshot.activeTurnId) restoredCore.markTurnStarted(binding.target, snapshot.id, snapshot.activeTurnId);
          });
        expect(await restoreRunningBinding()).toEqual([]);
        expect(service.autoReview(gatewayTarget)).toEqual({ threadId, reviewer: "auto_review", updated: false });
        expect(restoredCore.activeTurn(gatewayTarget)?.turnId).toBe(recoveringTurn.turnId);
        await expect(service.updateAutoReview(gatewayTarget, false)).rejects.toMatchObject({ code: "conversation.busy" });
        await expect(execution.steerTurn(threadId, recoveringTurn.turnId,
          [{ type: "text", text: "must remain blocked" }], "codex_connect:blocked-recovery"))
          .rejects.toMatchObject({ code: "autoreview.execution-blocked" });
        expect((await client.resumeThread(threadId, workspace)).approvalsReviewer).toBe("auto_review");
        expect(completedStatuses.has(recoveringTurn.turnId)).toBe(false);
        expect(await service.stop(gatewayTarget)).toBe(true);
        await waitFor(() => completedStatuses.get(recoveringTurn.turnId) === "interrupted", 5_000);
        await gateInbound.drain();
        expect(restoredCore.activeTurn(gatewayTarget)).toBeUndefined();
        // Failure to confirm an idle convergence blocks execution, while a
        // later management restore still captures the actual setting.
        vi.spyOn(admission, "updateThreadApprovalsReviewer").mockRejectedValueOnce(new Error("isolated confirmation failure"));
        await expect(admission.admitThreadApprovalsReviewer(threadId))
          .rejects.toMatchObject({ code: "autoreview.execution-blocked" });
        expect(await restoreRunningBinding()).toEqual([]);
        expect(service.autoReview(gatewayTarget).reviewer).toBe("auto_review");
        expect(await service.updateAutoReview(gatewayTarget, false)).toEqual({ threadId, reviewer: "user", updated: true });
        expect((await client.resumeThread(threadId, workspace)).approvalsReviewer).toBe("user");
      } finally {
        removeGateNotification?.();
        await gateInbound?.close().catch(() => undefined);
        await gateOutput?.close().catch(() => undefined);
        removeNotification?.();
        if (threadId) {
          await client?.unsubscribeThread(threadId).catch(() => undefined);
          await client?.deleteThread(threadId).catch(() => undefined);
        }
        await client?.close().catch(() => undefined);
        if (processHandle.exitCode === null) {
          await stopDetachedTestProcess(processHandle, 10_000);
        }
        for (const response of apiServerResponses.keys()) response.end();
        await new Promise<void>((resolveClose, rejectClose) => {
          apiServer.close((error) => error ? rejectClose(error) : resolveClose());
        });
        rmSync(testRuntime, { recursive: true, force: true });
      }
    }, 45_000);
});
