import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ScheduledTaskComposition } from "../src/bootstrap/scheduled-task-composition.js";
import type { ProviderRoutingClient } from "../src/codex-client/index.js";
import type { ConversationCore, OutputEvent } from "../src/conversation-core/index.js";
import type { EventBus } from "../src/event-bus/index.js";
import type { WorkspaceRegistry } from "../src/policy/index.js";
import type { SessionRouter } from "../src/session-routing/index.js";
import type { SqliteBindingStore } from "../src/storage/index.js";

describe("ScheduledTaskComposition", () => {
  it("owns the empty scheduler recovery, start, stop, and store lifecycle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-scheduled-composition-"));
    const subscribe = vi.fn();
    const composition = new ScheduledTaskComposition({
      stateDatabasePath: join(directory, "state.sqlite3"),
      router: {} as SessionRouter,
      codex: {
        isProviderConfigured: () => true,
        ensureProviderAvailable: async () => undefined,
        isModelAvailable: async () => true,
      } as unknown as ProviderRoutingClient,
      bindings: {
        conversations: () => [],
        actors: () => [],
      } as unknown as SqliteBindingStore,
      workspaces: {} as WorkspaceRegistry,
      core: {} as ConversationCore,
      output: { subscribe } as unknown as EventBus<OutputEvent>,
      logger: pino({ level: "silent" }),
      isSurfaceEnabled: () => true,
      creationContext: () => {
        throw new Error("空 Store 恢复不应读取创建上下文");
      },
      presentConfirmation: () => undefined,
    });

    expect(subscribe).toHaveBeenCalledWith(
      "scheduled-task-run-coordinator",
      expect.any(Function),
    );
    await composition.prepareRecovery();
    composition.start();
    await composition.stop();
    composition.close();
  });
});
