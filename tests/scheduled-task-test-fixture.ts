import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreateScheduledTaskInput } from "../src/scheduled-tasks/index.js";
import { secureTestDirectory } from "./support/windows-fixtures.js";

export const scheduledTaskBase = Date.parse("2026-01-01T00:00:00.000Z");

export function cleanupScheduledTaskTestFixtures(directories: string[]): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function scheduledTaskDatabasePath(
  directories: string[],
): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "codexc-scheduled-tasks-"));
  const privateDirectory = join(directory, "private");
  secureTestDirectory(privateDirectory);
  directories.push(directory);
  return {
    directory: privateDirectory,
    path: join(privateDirectory, "scheduled-tasks.sqlite3"),
  };
}

export function scheduledTaskInput(
  overrides: Partial<CreateScheduledTaskInput> = {},
): CreateScheduledTaskInput {
  return {
    taskId: "task-1",
    name: "Report",
    surface: "telegram",
    accountId: "default",
    conversationId: "conversation-1",
    actorId: "actor-1",
    workspaceId: "workspace-1",
    prompt: "read the report",
    schedule: { type: "daily", time: "09:00" },
    timezone: "UTC",
    createdAt: scheduledTaskBase,
    ...overrides,
  };
}
