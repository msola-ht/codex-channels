import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import { codexHomePath } from "../runtime/codex-home.mjs";

export async function updateCodexUserConfig(
  environment,
  createEdits,
  { createClient = createCodexUserConfigClient } = {},
) {
  const client = await createClient({ environment });
  try {
    await client.connect();
    const snapshot = await client.readUserConfigSnapshot();
    const edits = createEdits(snapshot.config);
    if (edits.length === 0) return;
    await client.writeUserConfigEdits(edits, { expectedVersion: snapshot.version });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function readCodexUserConfigSnapshot(
  environment,
  { createClient = createCodexUserConfigClient } = {},
) {
  const client = await createClient({ environment });
  try {
    await client.connect();
    return await client.readUserConfigSnapshot();
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function writeCodexUserConfigEdits(
  environment,
  edits,
  { expectedVersion, createClient = createCodexUserConfigClient } = {},
) {
  const client = await createClient({ environment });
  try {
    await client.connect();
    await client.writeUserConfigEdits(edits, {
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function createCodexUserConfigClient({
  environment = process.env,
  cwd = codexHomePath(environment),
} = {}) {
  const configuredBinary = stringValue(environment.CODEX_BINARY) || "codex";
  const codexBinary = isAbsolute(configuredBinary)
    ? realpathSync(configuredBinary)
    : configuredBinary;
  const {
    CodexAppServerClient,
    JsonRpcClient,
    StdioTransport,
  } = await import("../dist/codex-client/index.js");
  return new CodexAppServerClient(
    new JsonRpcClient(new StdioTransport({ codexBinary, cwd, environment })),
    { sandbox: "read-only" },
  );
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
