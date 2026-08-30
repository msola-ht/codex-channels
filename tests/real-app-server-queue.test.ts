import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { toConversationInputEvent, toThreadQueueChangedEvent } from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { appendDiagnostic, appServerFailure, stopDetachedTestProcess, waitFor } from "./support/real-app-server-helpers.js";

describe("real App Server Queue contract", () => {
  it("runs the native Queue capacity, paging, dispatch and restart contract", async () => {
    const testRuntime = mkdtempSync(join(tmpdir(), "codex-queue-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    const apiServerResponses = new Map<ServerResponse, string>();
    const responseIds: string[] = [];
    const apiServer = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "queue-contract-model", object: "model", owned_by: "contract" }],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        const responseId = `queue-contract-response-${responseIds.length + 1}`;
        responseIds.push(responseId);
        response.write(`data: ${JSON.stringify({
          type: "response.created",
          response: { id: responseId },
        })}\n\n`);
        apiServerResponses.set(response, responseId);
        response.once("close", () => apiServerResponses.delete(response));
        return;
      }
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "queue contract fixture endpoint" } }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("Queue 合同无法创建本机 Responses 夹具");
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "queue-contract-model"',
      'model_provider = "queue-contract"',
      "",
      "[model_providers.queue-contract]",
      'name = "Queue Contract Provider"',
      `base_url = "http://127.0.0.1:${apiAddress.port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
    ].join("\n"), { mode: 0o600 });

    let stderr = "";
    const startProcess = (): ChildProcess => {
      const child = spawn(
        process.env.CODEX_BINARY ?? "codex",
        ["app-server", "--listen", `unix://${socketPath}`],
        {
          cwd: process.cwd(),
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ["ignore", "ignore", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = appendDiagnostic(stderr, chunk);
      });
      return child;
    };
    let processHandle = startProcess();
    let client: CodexAppServerClient | undefined;
    let threadId: string | undefined;
    let coldThreadId: string | undefined;
    let activeTurnId: string | undefined;
    let removeNotification: (() => void) | undefined;
    const changedThreadIds: string[] = [];
    const startedTurnIds = new Set<string>();
    const completedTurnIds = new Set<string>();
    const attachNotifications = (): void => {
      removeNotification?.();
      removeNotification = client?.onNotification((notification) => {
        const changed = toThreadQueueChangedEvent(notification);
        if (changed) changedThreadIds.push(changed.threadId);
        const event = toConversationInputEvent(notification);
        if (!event || !("threadId" in event)) return;
        if (event.type === "turn.started") startedTurnIds.add(event.turnId);
        if (event.type === "turn.completed") completedTurnIds.add(event.turnId);
      });
    };
    const completeResponse = (responseId: string): void => {
      const response = [...apiServerResponses.entries()]
        .find(([, id]) => id === responseId)?.[0];
      if (!response) {
        throw new Error(`找不到待完成的 Responses 夹具：${responseId}`);
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
    try {
      await waitFor(
        () => existsSync(socketPath),
        10_000,
        () => processHandle.exitCode === null
          ? undefined
          : new Error(appServerFailure("Queue 合同 App Server 启动失败", stderr)),
      );
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "workspace-write" },
      );
      await client.connect();
      const started = await client.startThread(workspace);
      threadId = started.thread.id;
      attachNotifications();
      try {
        const turn = await client.startTurn(
          threadId,
          [{ type: "text", text: "Hold this controlled turn open for Queue contract." }],
          "codex_connect:queue-contract",
          workspace,
        );
        activeTurnId = turn.turnId;
        await waitFor(() => responseIds.length >= 1, 5_000);

        const queuedItems = [];
        for (let index = 0; index < 100; index += 1) {
          queuedItems.push(await client.addQueueItem(
            threadId,
            `queue contract ${index + 1}`,
            `codex_connect:queue-contract-${index + 1}`,
          ));
        }
        await expect(client.addQueueItem(
          threadId,
          "queue contract 101",
          "codex_connect:queue-contract-101",
        )).rejects.toThrow("100");
        const full = await client.listQueue(threadId, { limit: 100 });
        expect(full.nextCursor).toBeNull();
        expect(full.items).toHaveLength(100);
        const pages = [];
        let cursor: string | null = null;
        do {
          const page = await client.listQueue(threadId, { cursor, limit: 25 });
          pages.push(page);
          cursor = page.nextCursor;
        } while (cursor !== null);
        expect(pages).toHaveLength(4);
        expect(pages.flatMap((page) => page.items)).toHaveLength(100);
        expect(pages.map((page) => page.items.length)).toEqual([25, 25, 25, 25]);

        await expect(client.startQueueItem(threadId, queuedItems[0]!.id))
          .rejects.toThrow("active or pending turn");
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(100);

        await client.interruptTurn(threadId, activeTurnId);
        await waitFor(() => completedTurnIds.has(activeTurnId!), 10_000);
        activeTurnId = undefined;
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(100);

        const specified = queuedItems[1]!;
        const specifiedTurn = await client.startQueueItem(threadId, specified.id);
        await waitFor(() => startedTurnIds.has(specifiedTurn.turnId), 10_000);
        await client.interruptTurn(threadId, specifiedTurn.turnId);
        await waitFor(() => completedTurnIds.has(specifiedTurn.turnId), 10_000);
        expect((await client.listQueue(threadId, { limit: 100 })).items)
          .toHaveLength(99);

        const beforeReorder = await client.listQueue(threadId, { limit: 100 });
        const first = beforeReorder.items[0]!;
        expect((await client.updateQueueItem(threadId, first.id, "queue contract edited")).id)
          .toBe(first.id);
        await client.reorderQueue(threadId, [
          ...beforeReorder.items.slice(1).map((item) => item.id),
          first.id,
        ]);
        expect(await client.deleteQueueItem(threadId, first.id)).toEqual({ deleted: true });

        const ordinaryResponseIndex = responseIds.length;
        const ordinary = await client.startTurn(
          threadId,
          [{ type: "text", text: "Complete this ordinary turn and dispatch Queue." }],
          "codex_connect:queue-contract-ordinary",
          workspace,
        );
        await waitFor(() => responseIds.length > ordinaryResponseIndex, 5_000);
        completeResponse(responseIds[ordinaryResponseIndex]!);
        await waitFor(() => completedTurnIds.has(ordinary.turnId), 10_000);
        await waitFor(
          () => [...startedTurnIds].some((id) => id !== turn.turnId && id !== specifiedTurn.turnId
            && id !== ordinary.turnId),
          10_000,
        );
        const autoTurnId = [...startedTurnIds].find((id) => id !== turn.turnId
          && id !== specifiedTurn.turnId && id !== ordinary.turnId);
        expect(autoTurnId).toBeDefined();
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(97);
        await client.interruptTurn(threadId, autoTurnId!);
        await waitFor(() => completedTurnIds.has(autoTurnId!), 10_000);

        const persistedQueuedId = (await client.listQueue(threadId, { limit: 100 })).items[0]!.id;
        const coldThread = await client.startThread(workspace);
        coldThreadId = coldThread.thread.id;
        const materializeResponseIndex = responseIds.length;
        const materialize = await client.startTurn(
          coldThreadId,
          [{ type: "text", text: "Materialize a completed cold Queue fixture." }],
          "codex_connect:queue-cold-materialize",
          workspace,
        );
        await waitFor(() => responseIds.length > materializeResponseIndex, 5_000);
        completeResponse(responseIds[materializeResponseIndex]!);
        await waitFor(() => completedTurnIds.has(materialize.turnId), 10_000);
        await client.unsubscribeThread(coldThreadId);

        removeNotification?.();
        removeNotification = undefined;
        await client.unsubscribeThread(threadId);
        await client.close();
        client = undefined;
        await stopDetachedTestProcess(processHandle, 10_000);
        rmSync(socketPath, { force: true });
        processHandle = startProcess();
        await waitFor(
          () => existsSync(socketPath),
          10_000,
          () => processHandle.exitCode === null
            ? undefined
            : new Error(appServerFailure("Queue 冷恢复合同 App Server 启动失败", stderr)),
        );
        client = new CodexAppServerClient(
          new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
          { sandbox: "workspace-write" },
        );
        await client.connect();
        attachNotifications();
        const coldResume = await client.resumeThread(threadId, workspace);
        expect(coldResume.thread.id).toBe(threadId);
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(97);
        const interruptedColdResponseIndex = responseIds.length;
        const interruptedColdTurn = await client.startQueueItem(threadId, persistedQueuedId);
        await waitFor(() => startedTurnIds.has(interruptedColdTurn.turnId), 10_000);
        await waitFor(() => responseIds.length > interruptedColdResponseIndex, 5_000);
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(96);
        await client.interruptTurn(threadId, interruptedColdTurn.turnId);
        await waitFor(() => completedTurnIds.has(interruptedColdTurn.turnId), 10_000);

        const coldQueued = await client.addQueueItem(
          coldThreadId,
          "dispatch after a normally completed cold Thread resumes",
          "codex_connect:queue-cold-resume",
        );
        expect((await client.listQueue(coldThreadId, { limit: 100 })).items)
          .toEqual([coldQueued]);
        const startedBeforeColdResume = new Set(startedTurnIds);
        const coldResponseIndex = responseIds.length;
        const resumedColdThread = await client.resumeThread(coldThreadId, workspace);
        expect(resumedColdThread.thread.id).toBe(coldThreadId);
        await waitFor(
          () => [...startedTurnIds].some((id) => !startedBeforeColdResume.has(id)),
          10_000,
        );
        const coldTurnId = [...startedTurnIds].find((id) => !startedBeforeColdResume.has(id));
        expect(coldTurnId).toBeDefined();
        await waitFor(() => responseIds.length > coldResponseIndex, 5_000);
        expect((await client.listQueue(coldThreadId, { limit: 100 })).items).toHaveLength(0);
        await client.interruptTurn(coldThreadId, coldTurnId!);
        await waitFor(() => completedTurnIds.has(coldTurnId!), 10_000);
        await waitFor(() => changedThreadIds.length >= 100, 2_000);
        expect(changedThreadIds.every((id) => id === threadId || id === coldThreadId)).toBe(true);
      } finally {
        removeNotification?.();
        removeNotification = undefined;
      }
    } finally {
      if (activeTurnId && threadId) {
        await client?.interruptTurn(threadId, activeTurnId).catch(() => undefined);
      }
      if (threadId) {
        await client?.unsubscribeThread(threadId).catch(() => undefined);
        await client?.deleteThread(threadId).catch(() => undefined);
      }
      if (coldThreadId) {
        await client?.unsubscribeThread(coldThreadId).catch(() => undefined);
        await client?.deleteThread(coldThreadId).catch(() => undefined);
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
