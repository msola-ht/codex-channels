import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync as rawMkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { stringify } from "smol-toml";

import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  opencodeGoAccountDefinition,
  type ModelProviderDefinition
} from "../runtime/model-provider-definitions.mjs";
import { secureTestDirectory } from "./support/windows-fixtures.js";

export const cli = resolve("bin/codexc.mjs");

export const execFileAsync = promisify(execFile);

export const unixSocketTmpdir = process.platform === "darwin" ? "/tmp" : tmpdir();

export function mkdtempSync(prefix: string): string {
  const root = rawMkdtempSync(prefix);
  if (process.platform === "win32") secureTestDirectory(root);
  return root;
}

export function updateGatewayConfig(
  configPath: string,
  update: (document: Record<string, unknown>) => void,
): void {
  const document = readGatewayConfig(configPath);
  update(document);
  writeGatewayConfig(configPath, document);
}

export function table(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("测试配置表无效");
  }
  return value as Record<string, unknown>;
}

export function writeManagedProviderFixture(
  codexHome: string,
  connectHome: string,
  definition: ModelProviderDefinition,
  mode: "switching" | "exclusive",
  apiKey = "sk-service-secret",
) {
  const resolvedDefinition = definition.capabilities.instanceAdapter === "opencode-go-accounts"
    && definition.accountId === undefined
    ? opencodeGoAccountDefinition("main")
    : definition;
  const providerDirectory = join(
    connectHome,
    "providers",
    resolvedDefinition.storageId ?? resolvedDefinition.id,
  );
  mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
  const catalogPath = join(providerDirectory, resolvedDefinition.catalogFileName);
  writeFileSync(catalogPath, managedModelCatalog(resolvedDefinition), { mode: 0o600 });
  const target = mode === "exclusive"
    ? join(codexHome, "config.toml")
    : join(codexHome, resolvedDefinition.profileFileName);
  writeFileSync(target, stringify({
    model: resolvedDefinition.defaultModel,
    model_provider: resolvedDefinition.id,
    ...(mode === "switching" ? { model_reasoning_effort: resolvedDefinition.defaultReasoningEffort } : {}),
    model_catalog_json: catalogPath,
    model_providers: {
      [resolvedDefinition.id]: {
        name: resolvedDefinition.id,
        base_url: resolvedDefinition.baseUrl,
        wire_api: resolvedDefinition.wireApi,
        requires_openai_auth: false,
        ...(resolvedDefinition.supportsWebsockets === undefined
          ? {}
          : { supports_websockets: resolvedDefinition.supportsWebsockets }),
        experimental_bearer_token: apiKey,
      },
    },
  }), { mode: 0o600 });
  const markerDirectory = resolvedDefinition.accountId === undefined
    ? providerDirectory
    : join(providerDirectory, "accounts", resolvedDefinition.accountId);
  mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
  if (resolvedDefinition.accountId !== undefined) {
    writeFileSync(
      join(providerDirectory, "accounts.json"),
      `${JSON.stringify([{ id: resolvedDefinition.accountId, default: true }], null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  writeFileSync(
    join(markerDirectory, resolvedDefinition.managedMarkerFileName),
    stringify({ version: 1, provider: resolvedDefinition.id, mode }),
    { mode: 0o600 },
  );
}

export function managedModelCatalog(definition: ModelProviderDefinition): string {
  return `${JSON.stringify({
    models: [definition.defaultModel, "deepseek-v4-pro"].map((slug) => ({
      slug,
      display_name: slug,
      input_modalities: slug === "deepseek-v4-pro" ? ["text"] : ["text", "image"],
      context_window: 1_048_576,
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
      ],
    })),
  })}\n`;
}

export async function forEachWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex]!;
        nextIndex += 1;
        await visit(value);
      }
    },
  );
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export function runCliProcess(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectProcess);
    child.once("close", (status) => {
      resolveProcess({ status, stdout, stderr });
    });
  });
}

export async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  failure: () => Error | undefined = () => undefined,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    const error = failure();
    if (error) throw error;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待测试条件超时（${timeoutMs} ms）`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
