import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { toConversationInputEvent } from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { appendDiagnostic, appServerFailure, stopDetachedTestProcess, waitFor } from "./support/real-app-server-helpers.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;

contractSuite("real supervised App Server thread-state", () => {
    it("runs paginated history, active-turn Revert and preserved Queue against local Responses", async () => {
      const testRuntime = mkdtempSync(join(tmpdir(), "codex-revert-contract-"));
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
      let removeNotification: (() => void) | undefined;
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
        client = new CodexAppServerClient(
          new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
          { sandbox: "workspace-write" },
        );
        await client.connect();
        const started = await client.startThread(workspace);
        threadId = started.thread.id;
        expect(started.thread.historyMode).toBe("paginated");
        removeNotification = client.onNotification((notification) => {
          const event = toConversationInputEvent(notification);
          if (event?.type === "turn.completed") {
            completedStatuses.set(event.turnId, event.status);
          }
          if (event?.type === "thread.reverted") revertedThreadIds.push(event.threadId);
        });

        const firstTurnId = await startCompletedTurn("first revert turn", 0);
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
      } finally {
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
