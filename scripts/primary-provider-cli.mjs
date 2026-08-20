import * as clackPrompts from "@clack/prompts";
import { pathToFileURL } from "node:url";

import {
  backupPrimaryProviderCandidates,
  listCustomPrimaryProviderCandidates,
  readPrimaryProviderBackup,
  removePrimaryProviderBackupCandidate,
  restorePrimaryProviderCandidateEdits,
  validateCustomPrimaryModelProviderId,
} from "../runtime/model-provider-runtime.mjs";
import {
  writeCliMessage,
  writeCliRemediationRestartAll,
} from "../runtime/cli-presentation.mjs";
import {
  createCodexUserConfigClient,
  readCodexUserConfigSnapshot,
  writeCodexUserConfigEdits,
} from "./codex-user-config.mjs";
import { runCustomPrimaryProviderSetup } from "./custom-primary-provider-setup.mjs";
import { primaryProviderUsage } from "./primary-provider-usage.mjs";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

async function writeEditsRemovingBackupCandidate({
  id,
  environment,
  edits,
  expectedVersion,
  createClient,
  operation,
}) {
  const removedBackup = removePrimaryProviderBackupCandidate(id, environment);
  try {
    await writeCodexUserConfigEdits(environment, edits, {
      expectedVersion,
      createClient,
    });
  } catch (error) {
    if (removedBackup !== undefined) {
      try {
        backupPrimaryProviderCandidates({ [id]: removedBackup }, environment);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${operation}失败，且私有备份回滚失败`,
          { cause: rollbackError },
        );
      }
    }
    throw error;
  }
}

export async function listPrimaryProviders({
  environment = process.env,
  output = process.stdout,
  createClient = createCodexUserConfigClient,
} = {}) {
  const snapshot = await readCodexUserConfigSnapshot(environment, { createClient });
  const config = record(snapshot.config);
  const providers = record(config.model_providers);
  const candidates = listCustomPrimaryProviderCandidates(providers);
  const backup = readPrimaryProviderBackup(environment);
  const backupIds = Object.keys(backup).filter((id) => !candidates.includes(id));
  const activeId = optionalString(config.model_provider);
  const activeLabel = activeId === undefined || activeId === "openai"
    ? "OpenAI 官方"
    : candidates.includes(activeId)
      ? `${activeId} · 自定义`
      : backupIds.includes(activeId)
        ? `${activeId} · 自定义（备份中）`
      : `${activeId}（未在候选列表中）`;

  output.write("\nCodex Connect 主 Provider\n");
  output.write(`当前激活：${activeLabel}\n`);
  if (candidates.length === 0) {
    output.write("自定义候选：无\n");
  } else {
    output.write("自定义候选：\n");
    for (const id of candidates) {
      const provider = record(providers[id]);
      const name = optionalString(provider.name) ?? id;
      const baseUrl = typeof provider.base_url === "string" ? provider.base_url : "";
      const active = id === activeId ? " · 当前" : "";
      output.write(`- ${name}（${id}）· ${baseUrl}${active}\n`);
    }
  }
  if (backupIds.length > 0) {
    output.write("备份候选（已从 config 清理，可切回）：\n");
    for (const id of backupIds) {
      const provider = record(backup[id]);
      const name = optionalString(provider.name) ?? id;
      const baseUrl = typeof provider.base_url === "string" ? provider.base_url : "";
      output.write(`- ${name}（${id}）· ${baseUrl}\n`);
    }
  }
  output.write("\n切换：codexc primary-provider switch <Provider ID>；新增：codexc primary-provider add。\n");
}

export async function switchPrimaryProvider(
  providerId,
  model,
  {
    environment = process.env,
    output = process.stdout,
    createClient = createCodexUserConfigClient,
  } = {},
) {
  const normalizedId = String(providerId).trim();
  const normalizedModel = optionalString(model);
  const snapshot = await readCodexUserConfigSnapshot(environment, { createClient });
  const config = record(snapshot.config);
  const providers = record(config.model_providers);
  if (normalizedId === "openai") {
    const currentProvider = optionalString(config.model_provider);
    const clearsCustomModel = currentProvider !== undefined && currentProvider !== "openai";
    const candidates = listCustomPrimaryProviderCandidates(providers);
    const backedUp = backupPrimaryProviderCandidates(providers, environment);
    const removesTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
    const edits = [
      ...(removesTopLevelBaseUrl
        ? [{ keyPath: "openai_base_url", value: null }]
        : []),
      { keyPath: "model_provider", value: "openai" },
      ...(clearsCustomModel ? [{ keyPath: "model", value: null }] : []),
      ...candidates.map((id) => ({ keyPath: `model_providers.${id}`, value: null })),
    ];
    await writeCodexUserConfigEdits(environment, edits, {
      expectedVersion: snapshot.version,
      createClient,
    });
    if (removesTopLevelBaseUrl) {
      output.write("已移除与官方主 Provider 冲突的顶层 openai_base_url。\n");
    }
    output.write(
      backedUp.length === 0
        ? "已切换到官方 OpenAI 主 Provider（未运行 codex login，官方凭据保留）。\n"
        : `已切换到官方 OpenAI 主 Provider（未运行 codex login，官方凭据保留）；`
          + `自定义候选已移入私有备份：${backedUp.join("、")}。\n`,
    );
    writeCliRemediationRestartAll();
    return;
  }
  const reservedError = validateCustomPrimaryModelProviderId(normalizedId);
  if (reservedError !== null) {
    throw new Error(reservedError);
  }
  const candidates = listCustomPrimaryProviderCandidates(providers);
  const restoreEdits = candidates.includes(normalizedId)
    ? []
    : restorePrimaryProviderCandidateEdits(normalizedId, environment) ?? [];
  if (!candidates.includes(normalizedId) && restoreEdits.length === 0) {
    throw new Error(
      `未找到自定义主 Provider：${normalizedId}；可用 codexc primary-provider list 查看候选`,
    );
  }
  if (!candidates.includes(normalizedId)) {
    output.write(`从备份恢复自定义主 Provider：${normalizedId}。\n`);
  }
  const removesTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
  const edits = [
    ...restoreEdits,
    ...(removesTopLevelBaseUrl
      ? [{ keyPath: "openai_base_url", value: null }]
      : []),
    { keyPath: "model_provider", value: normalizedId },
    ...(normalizedModel === undefined
      ? []
      : [{ keyPath: "model", value: normalizedModel }]),
  ];
  await writeEditsRemovingBackupCandidate({
    id: normalizedId,
    environment,
    edits,
    expectedVersion: snapshot.version,
    createClient,
    operation: `恢复自定义主 Provider ${normalizedId}`,
  });
  if (removesTopLevelBaseUrl) {
    output.write("已移除与自定义主 Provider 冲突的顶层 openai_base_url。\n");
  }
  output.write(`已切换到自定义主 Provider：${normalizedId}。\n`);
  writeCliRemediationRestartAll();
}

export async function removePrimaryProvider(
  providerId,
  {
    environment = process.env,
    output = process.stdout,
    createClient = createCodexUserConfigClient,
  } = {},
) {
  const normalizedId = String(providerId).trim();
  const snapshot = await readCodexUserConfigSnapshot(environment, { createClient });
  const config = record(snapshot.config);
  const candidates = listCustomPrimaryProviderCandidates(record(config.model_providers));
  if (!candidates.includes(normalizedId)) {
    throw new Error(`未找到自定义主 Provider：${normalizedId}；可用 codexc primary-provider list 查看候选`);
  }
  const activeId = optionalString(config.model_provider);
  const edits = [
    { keyPath: `model_providers.${normalizedId}`, value: null },
    ...(activeId === normalizedId
      ? [
          { keyPath: "model_provider", value: "openai" },
          { keyPath: "model", value: null },
        ]
      : []),
  ];
  await writeEditsRemovingBackupCandidate({
    id: normalizedId,
    environment,
    edits,
    expectedVersion: snapshot.version,
    createClient,
    operation: `删除自定义主 Provider ${normalizedId}`,
  });
  output.write(
    activeId === normalizedId
      ? `已删除自定义主 Provider ${normalizedId} 并恢复官方 OpenAI 主 Provider。\n`
      : `已删除自定义主 Provider 候选：${normalizedId}。\n`,
  );
  writeCliRemediationRestartAll();
}

export async function addPrimaryProvider(options = {}) {
  return runCustomPrimaryProviderSetup({
    allowBack: false,
    ...options,
  });
}

export async function runCustomPrimaryProviderMenu({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  allowBack = false,
  createClient = createCodexUserConfigClient,
} = {}) {
  while (true) {
    const action = await prompts.select({
      message: "自定义主 Provider",
      showInstructions: false,
      options: [
        { value: "add", label: "新增或更新", hint: "固定 ID OpenAI，交互式填写并激活" },
        { value: "list", label: "列表", hint: "查看当前激活项与候选" },
        { value: "switch", label: "切换", hint: "切换到已配置候选" },
        { value: "official", label: "切回官方", hint: "不运行登录，官方凭据保留；候选移入私有备份" },
        { value: "remove", label: "删除", hint: "删除候选；删除激活项时恢复官方" },
        ...(allowBack
          ? [{ value: "back", label: "返回", hint: "返回模型与提供商设置" }]
          : []),
      ],
    });
    if (prompts.isCancel(action) || action === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
    if (action === "add") {
      const result = await addPrimaryProvider({ environment, output, prompts, createClient });
      if (result === undefined || result?.action !== undefined) {
        continue;
      }
      output.write("已新增并激活自定义主 Provider；可继续选择其他操作或返回。\n");
      continue;
    }
    if (action === "list") {
      await listPrimaryProviders({ environment, output, createClient });
      continue;
    }
    if (action === "official") {
      await switchPrimaryProvider("openai", undefined, { environment, output, createClient });
      continue;
    }
    if (action === "switch" || action === "remove") {
      const id = await selectCustomPrimaryCandidate({
        environment,
        output,
        prompts,
        createClient,
        message: action === "switch"
          ? "切换到哪个自定义主 Provider？"
          : "删除哪个自定义主 Provider？",
        includeBackup: action === "switch",
      });
      if (id === undefined) {
        continue;
      }
      if (action === "switch") {
        await switchPrimaryProvider(id, undefined, { environment, output, createClient });
      } else {
        await removePrimaryProvider(id, { environment, output, createClient });
      }
      continue;
    }
    throw new Error(`未知自定义主 Provider 操作：${String(action)}`);
  }
}

async function selectCustomPrimaryCandidate({
  environment,
  output,
  prompts,
  createClient,
  message,
  includeBackup = false,
}) {
  const snapshot = await readCodexUserConfigSnapshot(environment, { createClient });
  const configured = listCustomPrimaryProviderCandidates(
    record(snapshot.config.model_providers),
  );
  const backup = includeBackup ? readPrimaryProviderBackup(environment) : {};
  const backupIds = includeBackup
    ? Object.keys(backup).filter((id) => !configured.includes(id))
    : [];
  const candidates = [...configured, ...backupIds];
  if (candidates.length === 0) {
    output.write(
      includeBackup
        ? "暂无自定义主 Provider 候选或备份，请先选择“新增或更新”。\n"
        : "暂无自定义主 Provider 候选，请先选择“新增或更新”。\n",
    );
    return undefined;
  }
  const id = await prompts.select({
    message,
    showInstructions: false,
    options: candidates.map((candidate) => {
      const provider = record(record(snapshot.config.model_providers)[candidate] ?? backup[candidate]);
      const name = optionalString(provider.name) ?? candidate;
      const baseUrl = typeof provider.base_url === "string" ? provider.base_url : "";
      const label = name === candidate ? candidate : `${name}（${candidate}）`;
      return {
        value: candidate,
        label: `${label} · ${baseUrl}`,
        ...(backupIds.includes(candidate)
          ? { hint: "从备份恢复" }
          : {}),
      };
    }),
  });
  if (prompts.isCancel(id) || id === "back") {
    return undefined;
  }
  return String(id);
}

export async function runPrimaryProviderCli(
  args,
  {
    environment = process.env,
    output = process.stdout,
    prompts = clackPrompts,
    createClient = createCodexUserConfigClient,
  } = {},
) {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help") {
    output.write(`${primaryProviderUsage}\n`);
    return;
  }
  if (subcommand === "list") {
    if (rest.length > 0) {
      throw new Error("用法：codexc primary-provider list");
    }
    await listPrimaryProviders({ environment, output, createClient });
    return;
  }
  if (subcommand === "add") {
    if (rest.length > 0) {
      throw new Error("用法：codexc primary-provider add");
    }
    await addPrimaryProvider({ environment, output, prompts, createClient });
    return;
  }
  if (subcommand === "switch") {
    if (rest.length === 0 || rest.length > 2 || (rest[0] === "openai" && rest.length !== 1)) {
      throw new Error("用法：codexc primary-provider switch <Provider ID> [模型]");
    }
    await switchPrimaryProvider(rest[0], rest[1], { environment, output, createClient });
    return;
  }
  if (subcommand === "remove") {
    if (rest.length !== 1) {
      throw new Error("用法：codexc primary-provider remove <Provider ID>");
    }
    await removePrimaryProvider(rest[0], { environment, output, createClient });
    return;
  }
  throw new Error(`未知子命令：${subcommand}\n${primaryProviderUsage}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrimaryProviderCli(process.argv.slice(2)).catch((error) => {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
