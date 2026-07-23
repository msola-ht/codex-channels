import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acknowledgeConfigEvents,
  configEventQueuePath,
  discardWorkspaceConfigEvents,
  enqueueWorkspaceAdded,
  matchingWorkspaceConfigEvents,
  readConfigEvents,
} from "../scripts/config-event-queue.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("config event queue", () => {
  it("persists, matches and acknowledges Workspace additions", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-config-events-"));
    temporaryDirectories.push(root);
    const queuePath = configEventQueuePath(root);
    const project = {
      id: "project",
      name: "Project",
      cwd: join(root, "Project"),
    };
    const docs = {
      id: "docs",
      name: "Docs",
      cwd: join(root, "Docs"),
    };

    const projectEvent = enqueueWorkspaceAdded(queuePath, project);
    const docsEvent = enqueueWorkspaceAdded(queuePath, docs);
    const events = readConfigEvents(queuePath);

    expect(events).toMatchObject([
      { id: projectEvent.id, type: "workspace-added", workspace: project },
      { id: docsEvent.id, type: "workspace-added", workspace: docs },
    ]);
    expect(matchingWorkspaceConfigEvents(events, [project])).toMatchObject([
      { id: projectEvent.id, workspace: project },
    ]);
    expect(statSync(queuePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "data")).mode & 0o777).toBe(0o700);

    acknowledgeConfigEvents(queuePath, [projectEvent.id]);
    expect(readConfigEvents(queuePath)).toMatchObject([
      { id: docsEvent.id, workspace: docs },
    ]);

    discardWorkspaceConfigEvents(queuePath, ["docs"]);
    expect(readConfigEvents(queuePath)).toEqual([]);
    expect(JSON.parse(readFileSync(queuePath, "utf8"))).toEqual({
      version: 1,
      events: [],
    });
  });

  it("preserves malformed queues instead of silently discarding events", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-config-events-"));
    temporaryDirectories.push(root);
    const queuePath = configEventQueuePath(root);
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(queuePath, "{broken", { mode: 0o600 });

    expect(() => readConfigEvents(queuePath)).toThrow("不是有效 JSON");
    expect(readFileSync(queuePath, "utf8")).toBe("{broken");
  });
});
