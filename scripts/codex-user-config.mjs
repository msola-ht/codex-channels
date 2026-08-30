import { isDeepStrictEqual } from "node:util";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  executableInvocation,
  resolveOptionalExecutable,
} from "../runtime/executable.mjs";
import { terminateChildProcess } from "../runtime/process-lifecycle.mjs";

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

export function areCodexUserConfigEditsApplied(config, edits) {
  return edits.every(({ keyPath, value }) => {
    const current = configValueAtPath(config, keyPath);
    return value === null ? current === undefined : isDeepStrictEqual(current, value);
  });
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
  const codexBinary = resolveOptionalExecutable(configuredBinary, environment) ?? configuredBinary;
  const {
    CodexAppServerClient,
    JsonRpcClient,
    StdioTransport,
  } = await import("../dist/codex-client/index.js");
  return new CodexAppServerClient(
    new JsonRpcClient(new StdioTransport({
      codexBinary,
      cwd,
      environment,
      createCodexProcessInvocation: (args) =>
        executableInvocation(codexBinary, args, environment),
      terminateCodexProcess: terminateChildProcess,
    })),
    { sandbox: "read-only" },
  );
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function configValueAtPath(config, keyPath) {
  let current = config;
  for (const segment of keyPath.split(".")) {
    if (
      current === null
      || typeof current !== "object"
      || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}
