import { describe, expect, it, vi } from "vitest";

import {
  createScheduledTaskServerRequestHandler,
  type ScheduledTaskThreadLookup,
} from "../src/bootstrap/index.js";
import type { RpcServerRequest } from "../src/codex-client/index.js";

const scheduledThread = "scheduled-thread";

function request(method: string, threadId = scheduledThread): RpcServerRequest {
  return {
    id: 1,
    method,
    params: { threadId },
  };
}

describe("scheduled-task server request boundary", () => {
  it("returns protocol-shaped safe refusals for every supported request", async () => {
    const lookup: ScheduledTaskThreadLookup = {
      taskForThread: (threadId) => threadId === scheduledThread ? {} : undefined,
      noteServerRequestRejected: vi.fn(),
    };
    const fallback = vi.fn(async () => ({ fallback: true }));
    const handle = createScheduledTaskServerRequestHandler(lookup, fallback);

    await expect(handle(request("item/commandExecution/requestApproval")))
      .resolves.toEqual({ decision: "decline" });
    await expect(handle(request("item/fileChange/requestApproval")))
      .resolves.toEqual({ decision: "decline" });
    await expect(handle(request("item/permissions/requestApproval")))
      .resolves.toEqual({ permissions: {}, scope: "turn" });
    await expect(handle(request("item/tool/requestUserInput")))
      .resolves.toEqual({ answers: {} });
    await expect(handle(request("mcpServer/elicitation/request")))
      .resolves.toEqual({ action: "cancel", content: null, _meta: null });
    expect(fallback).not.toHaveBeenCalled();
    expect(lookup.noteServerRequestRejected).toHaveBeenCalledTimes(5);
  });

  it("delegates non-scheduled and unsupported requests to the existing handler", async () => {
    const fallback = vi.fn(async (request: RpcServerRequest) => ({ method: request.method }));
    const handle = createScheduledTaskServerRequestHandler({
      taskForThread: (threadId) => threadId === scheduledThread ? {} : undefined,
    }, fallback);

    await expect(handle(request("item/commandExecution/requestApproval", "foreground")))
      .resolves.toEqual({ method: "item/commandExecution/requestApproval" });
    await expect(handle(request("unknown/serverRequest")))
      .rejects.toMatchObject({ code: -32601 });
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
