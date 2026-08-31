import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  backupPrimaryProviderCandidates,
  primaryProviderBackupPath,
  readPrimaryProviderBackup,
} from "../runtime/model-provider-runtime.mjs";

function environmentForConnectHome(connectHome: string): NodeJS.ProcessEnv {
  const codexHome = join(connectHome, "codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
}

describe("primary Provider private backup", () => {
  it("rejects a backup file readable by other users", () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-primary-provider-permissions-"));
    const environment = environmentForConnectHome(connectHome);
    backupPrimaryProviderCandidates({
      OpenAI: {
        name: "OpenAI",
        base_url: "https://example.test/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-private",
      },
    }, environment);
    chmodSync(primaryProviderBackupPath(environment), 0o644);

    expect(() => readPrimaryProviderBackup(environment)).toThrow("无法安全读取");
  });
});
