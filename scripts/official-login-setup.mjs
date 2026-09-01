import { spawnSync } from "node:child_process";

import * as clackPrompts from "@clack/prompts";

import {
  executableInvocation,
  resolveOptionalExecutable,
} from "../runtime/executable.mjs";
import {
  backupPrimaryProviderCandidates,
  listCustomPrimaryProviderCandidates,
} from "../runtime/model-provider-runtime.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";
import { assertThirdPartyRoleDoesNotUseProvider } from "./agents.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function resolveCodexBinary(environment) {
  const configured = typeof environment.CODEX_BINARY === "string"
    ? environment.CODEX_BINARY.trim()
    : "";
  const binary = configured || "codex";
  return resolveOptionalExecutable(binary, environment) ?? binary;
}

function defaultRunLogin({ codexBinary, environment }) {
  const invocation = executableInvocation(
    codexBinary,
    ["login", "--device-auth"],
    environment,
  );
  const result = spawnSync(invocation.file, invocation.args, {
    stdio: "inherit",
    env: environment,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
  const currentProvider = optionalString(config.model_provider);
  if (currentProvider !== undefined && currentProvider !== "openai") {
    assertThirdPartyRoleDoesNotUseProvider(currentProvider, environment);
  }
  const candidates = listCustomPrimaryProviderCandidates(record(config.model_providers));
  const hasTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;

  output.write("\nCodex Connect 官方登录模式 Setup\n\n");
  const notices = [
    ...(candidates.length > 0
      ? [`备份并停用自定义候选：${candidates.join("、")}（可用 primary-provider switch 切回）`]
      : []),
    ...(hasTopLevelBaseUrl ? ["移除顶层 openai_base_url"] : []),
  ];
  output.write(
    notices.length === 0
      ? "当前已是官方 OpenAI 模式，将直接运行 codex login --device-auth。\n"
      : `将执行：${notices.join("；")}。\n`,
  );

  const confirmed = await prompts.confirm({
    message: "切换到官方 OpenAI 模式并运行 codex login --device-auth？",
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改配置。\n");
    return undefined;
  }
  output.write("将运行 codex login --device-auth；打开终端显示的链接并输入验证码完成登录。\n");

  runLogin({
    codexBinary: resolveCodexBinary(environment),
    environment,
  });

  const backedUp = await withModelProviderManagementTransaction(environment, async () => {
    const writer = await createClient({ environment });
    try {
      await writer.connect();
      const currentSnapshot = await writer.readUserConfigSnapshot();
      const currentConfig = record(currentSnapshot.config);
      const activeProvider = optionalString(currentConfig.model_provider);
      if (activeProvider !== undefined && activeProvider !== "openai") {
        assertThirdPartyRoleDoesNotUseProvider(activeProvider, environment);
      }
      const currentCandidates = backupPrimaryProviderCandidates(
        record(currentConfig.model_providers),
        environment,
      );
      const edits = [
        ...(optionalString(currentConfig.openai_base_url) === undefined
          ? []
          : [{ keyPath: "openai_base_url", value: null }]),
        { keyPath: "model_provider", value: "openai" },
        ...(activeProvider !== undefined && activeProvider !== "openai"
          ? [{ keyPath: "model", value: null }]
          : []),
        ...currentCandidates.map((id) => ({
          keyPath: `model_providers.${id}`,
          value: null,
        })),
      ];
      await writer.writeUserConfigEdits(
        edits,
        { expectedVersion: currentSnapshot.version },
      );
      return currentCandidates;
    } finally {
      await writer.close().catch(() => undefined);
    }
  });
  output.write(
    backedUp.length === 0
      ? "已恢复官方 OpenAI 模式。\n"
      : `已恢复官方 OpenAI 模式（自定义候选已备份：${backedUp.join("、")}）。\n`,
  );
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
  output.write("旧会话仍使用创建时的 Provider，请用 /new 创建新会话。\n");
  return { mode: "official" };
}
