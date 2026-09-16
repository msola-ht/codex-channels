import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import type { CodexUserConfigValue } from "../scripts/codex-user-config.mjs";
import { secureTestDirectory } from "./support/windows-fixtures.js";

export const officialModels = [
  "gpt-5.6-sol",
  "model-a",
  "model-new",
  "model-old",
].map((model) => ({
  model,
  displayName: model,
  supportedReasoningEfforts: [{ effort: "high", description: "High" }],
  defaultReasoningEffort: "high",
  isDefault: model === "gpt-5.6-sol",
}));

export function isolatedEnvironment(prefix: string): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const codexHome = join(root, "codex");
  const connectHome = join(root, "connect");
  secureTestDirectory(codexHome);
  secureTestDirectory(connectHome);
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
}

export function environmentForConnectHome(connectHome: string): NodeJS.ProcessEnv {
  const codexHome = join(connectHome, "codex");
  secureTestDirectory(codexHome);
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
}

export function clientFixture(snapshot: {
  config: Record<string, CodexUserConfigValue | undefined>;
  version: string;
}) {
  const writeUserConfigEdits = vi.fn<
    (
      edits: Array<{ keyPath: string; value: unknown }>,
      options?: { expectedVersion?: string },
    ) => Promise<void>
  >(async () => undefined);
  const client = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listModels: vi.fn(async () => officialModels),
    readUserConfigSnapshot: vi.fn(async () => snapshot),
    writeUserConfigEdits,
  };
  return {
    client,
    createClient: vi.fn(async () => client),
    writeUserConfigEdits,
  };
}
