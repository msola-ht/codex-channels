import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { validateCustomPrimaryModelProviderId } from "../runtime/model-provider-runtime.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function customProviderCandidateIds(providers) {
  const entries = record(providers);
  return Object.keys(entries).filter((id) => {
    if (validateCustomPrimaryModelProviderId(id) !== null) return false;
    const provider = record(entries[id]);
    return typeof provider.base_url === "string" && provider.wire_api === "responses";
  });
}

function resolveCodexBinary(environment) {
  const configured = typeof environment.CODEX_BINARY === "string"
    ? environment.CODEX_BINARY.trim()
    : "";
  const binary = configured || "codex";
  return isAbsolute(binary) ? realpathSync(binary) : binary;
}

function defaultRunLogin({ codexBinary, environment }) {
  const result = spawnSync(codexBinary, ["login"], {
    stdio: "inherit",
    env: environment,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`codex login 未成功完成（退出码 ${result.status ?? "未知"}）`);
  }
}

export async function runOfficialLoginSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  createClient = createCodexUserConfigClient,
  runLogin = defaultRunLogin,
} = {}) {
  const client = await createClient({ environment });
  let snapshot;
  try {
    await client.connect();
    snapshot = await client.readUserConfigSnapshot();
  } finally {
    await client.close().catch(() => undefined);
  }
  const config = record(snapshot.config);
  const customIds = [
    ...customProviderCandidateIds(record(config.model_providers)),
    ...(typeof config.model_provider === "string"
      && validateCustomPrimaryModelProviderId(config.model_provider) === null
      ? [config.model_provider]
      : []),
  ];
  const uniqueCustomIds = [...new Set(customIds)];
  const hasTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;

  output.write("\nCodex Connect 官方登录模式 Setup\n\n");
  const removals = [
    ...uniqueCustomIds.map((id) => `自定义主 Provider 块 ${id}`),
    ...(hasTopLevelBaseUrl ? ["顶层 openai_base_url"] : []),
  ];
  output.write(
    removals.length === 0
      ? "当前已是官方 OpenAI 模式，将直接运行 codex login。\n"
      : `将清除：${removals.join("、")}；官方与第三方主 Provider 只能同时存在一个。\n`,
  );

  const confirmed = await prompts.confirm({
    message: "切换到官方 OpenAI 模式并运行 codex login？",
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改配置。\n");
    return undefined;
  }

  runLogin({
    codexBinary: resolveCodexBinary(environment),
    environment,
  });

  const edits = [
    ...uniqueCustomIds.map((id) => ({
      keyPath: `model_providers.${id}`,
      value: null,
    })),
    ...(hasTopLevelBaseUrl
      ? [{ keyPath: "openai_base_url", value: null }]
      : []),
    { keyPath: "model_provider", value: null },
  ];
  const writer = await createClient({ environment });
  try {
    await writer.connect();
    await writer.writeUserConfigEdits(edits, { expectedVersion: snapshot.version });
  } finally {
    await writer.close().catch(() => undefined);
  }
  output.write("已恢复官方 OpenAI 模式。请运行 codexc service restart all 生效。\n");
  output.write("旧会话仍使用创建时的 Provider，请用 /new 创建新会话。\n");
  return { mode: "official" };
}
