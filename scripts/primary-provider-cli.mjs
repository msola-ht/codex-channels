import * as clackPrompts from "@clack/prompts";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  backupPrimaryProviderCandidates,
  customPrimaryProviderProfilePath,
  listCustomPrimaryProviderCandidates,
  loadConfiguredCustomSwitchingModelProviders,
  loadCustomSwitchingProviderIds,
  readPrimaryProviderBackup,
  removeCustomPrimaryProviderSwitchingProfile,
  removePrimaryProviderBackupCandidate,
  restoreCustomPrimaryProviderSwitchingProfile,
  restorePrimaryProviderCandidateEdits,
  validateCustomPrimaryModelProviderId,
} from "../runtime/model-provider-runtime.mjs";
import { modelProviderBlockEdits } from "../runtime/model-provider-profile.mjs";
import {
  writeCliMessage,
  writeCliRemediationRestartAll,
} from "../runtime/cli-presentation.mjs";
import {
  areCodexUserConfigEditsApplied,
  createCodexUserConfigClient,
  readCodexUserConfigSnapshot,
} from "./codex-user-config.mjs";
import { runCustomPrimaryProviderSetup } from "./custom-primary-provider-setup.mjs";
import { primaryProviderUsage } from "./primary-provider-usage.mjs";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function switchingProfileSnapshot(environment, providerId) {
  if (providerId === undefined) return undefined;
  const switching = loadConfiguredCustomSwitchingModelProviders(environment)
    .find(({ id }) => id === providerId);
  if (switching === undefined) {
    return undefined;
  }
  return {
    providerId: switching.id,
    switching,
  };
}

async function writeEditsWithProfileRemoval({
  environment,
  providerId,
  edits,
  expectedVersion,
  createClient,
}) {
  const profile = switchingProfileSnapshot(environment, providerId);
  const client = await createClient({ environment });
  try {
    await client.connect();
    if (profile !== undefined) {
      removeCustomPrimaryProviderSwitchingProfile(
        environment,
        profile.providerId,
        profile.switching.profileContent,
      );
    }
    try {
      await client.writeUserConfigEdits(edits, { expectedVersion });
      return;
    } catch (error) {
      let currentConfig;
      let applied;
      try {
        currentConfig = (await readCodexUserConfigSnapshot(environment, { createClient })).config;
        applied = areCodexUserConfigEditsApplied(currentConfig, edits);
      } catch (confirmationError) {
        // AggregateError 已保留配置写入与结果确认两个原始错误。
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError(
          [error, confirmationError],
          "Codex 配置写入结果无法确认，自定义切换 Provider Profile 保持移除",
        );
      }
      if (applied) return;
      if (profile === undefined) throw error;
      const currentProvider = optionalString(record(currentConfig).model_provider);
      if (currentProvider !== undefined && currentProvider !== "openai") {
        throw error;
      }
      try {
        restoreCustomPrimaryProviderSwitchingProfile(
          environment,
          profile.switching.id,
          profile.switching.profileContent,
        );
      } catch (rollbackError) {
        // AggregateError 已保留配置写入与 Profile 回滚两个原始错误。
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError(
          [error, rollbackError],
          "Codex 配置写入失败，且自定义切换 Provider Profile 回滚失败",
        );
      }
      throw error;
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function writeEditsRemovingBackupCandidate({
  id,
  environment,
  edits,
  expectedVersion,
  createClient,
}) {
  await writeEditsWithProfileRemoval({
    environment,
    providerId: id,
    edits,
    expectedVersion,
    createClient,
  });
  try {
    removePrimaryProviderBackupCandidate(id, environment);
    return true;
  } catch {
    return false;
  }
}

function writeBackupCleanupWarning(output, id) {
  output.write(
    `Codex 配置已更新，但自定义主 Provider ${id} 的私有备份清理失败；`
    + "请修复私有备份权限后重试切换或删除。\n",
  );
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
  const switchingProviders = loadConfiguredCustomSwitchingModelProviders(environment);
  const activeLabel = switchingProviders.length > 0
    ? `OpenAI 官方 + ${switchingProviders.map(({ id }) => id).join("、")} · 自定义切换模式`
    : activeId === undefined || activeId === "openai"
      ? "OpenAI 官方"
    : candidates.includes(activeId)
      ? `${activeId} · 自定义固定模式`
      : backupIds.includes(activeId)
        ? `${activeId} · 自定义（备份中）`
      : `${activeId}（未在候选列表中）`;

  output.write("\nCodex Connect 自定义 Responses Provider\n");
  output.write(`当前主实例：${activeLabel}\n`);
  if (candidates.length === 0) {
    output.write("自定义固定候选：无\n");
  } else {
    output.write("自定义固定候选：\n");
    for (const id of candidates) {
      const provider = record(providers[id]);
      const name = optionalString(provider.name) ?? id;
      const baseUrl = typeof provider.base_url === "string" ? provider.base_url : "";
      const active = id === activeId
          ? " · 当前固定模式"
          : "";
      output.write(`- ${name}（${id}）· ${baseUrl}${active}\n`);
    }
  }
  if (switchingProviders.length > 0) {
    output.write("已启用的自定义切换 Provider：\n");
    for (const provider of switchingProviders) {
      output.write(`- ${provider.name}（${provider.id}）· ${provider.baseUrl} · Profile ${provider.profileName}\n`);
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
  output.write(
    "\n设为固定主 Provider：codexc primary-provider switch <Provider ID>；"
    + "新增：codexc primary-provider add；编辑：codexc setup 中选择自定义第三方 → 编辑。\n",
  );
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
  const switchingProviders = loadConfiguredCustomSwitchingModelProviders(environment);
  const switching = switchingProviders.find(({ id }) => id === normalizedId);
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
    await writeEditsWithProfileRemoval({
      environment,
      providerId: undefined,
      edits,
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
  const otherSwitchingProviderIds = switchingProviders
    .map(({ id }) => id)
    .filter((id) => id !== normalizedId);
  if (otherSwitchingProviderIds.length > 0) {
    throw new Error(
      `固定模式不能保留其他自定义切换 Provider；请先删除其他自定义切换 Provider：${otherSwitchingProviderIds.join("、")}`,
    );
  }
  const candidates = listCustomPrimaryProviderCandidates(providers);
  const switchingEdits = switching === undefined
    ? []
    : modelProviderBlockEdits(normalizedId, {
        name: switching.name,
        base_url: switching.baseUrl,
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: switching.supportsWebsockets,
        experimental_bearer_token: switching.apiKey,
      });
  const restoreEdits = candidates.includes(normalizedId)
    ? []
    : switchingEdits.length > 0
      ? switchingEdits
      : restorePrimaryProviderCandidateEdits(normalizedId, environment) ?? [];
  if (!candidates.includes(normalizedId) && restoreEdits.length === 0) {
    throw new Error(
      `未找到自定义主 Provider：${normalizedId}；可用 codexc primary-provider list 查看候选`,
    );
  }
  if (!candidates.includes(normalizedId) && switching === undefined) {
    output.write(`从备份恢复自定义主 Provider：${normalizedId}。\n`);
  }
  const removesTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
  const edits = [
    ...restoreEdits,
    ...(removesTopLevelBaseUrl
      ? [{ keyPath: "openai_base_url", value: null }]
      : []),
    { keyPath: "model_provider", value: normalizedId },
    ...(normalizedModel === undefined && switching === undefined
      ? []
      : [{ keyPath: "model", value: normalizedModel ?? switching?.model }]),
  ];
  const backupCleaned = await writeEditsRemovingBackupCandidate({
    id: normalizedId,
    environment,
    edits,
    expectedVersion: snapshot.version,
    createClient,
  });
  if (removesTopLevelBaseUrl) {
    output.write("已移除与自定义主 Provider 冲突的顶层 openai_base_url。\n");
  }
  output.write(`已设为固定主 Provider：${normalizedId}。\n`);
  if (!backupCleaned) {
    writeBackupCleanupWarning(output, normalizedId);
  }
  writeCliRemediationRestartAll();
}

export async function removePrimaryProvider(
  providerId,
  {
    environment = process.env,
    output = process.stdout,
    prompts = clackPrompts,
    confirmRemoval = false,
    createClient = createCodexUserConfigClient,
  } = {},
) {
  const normalizedId = String(providerId).trim();
  const switchingProviderIds = loadCustomSwitchingProviderIds(environment);
  const staleSwitchingRegistration = switchingProviderIds.includes(normalizedId)
    && !existsSync(customPrimaryProviderProfilePath(environment, normalizedId));
  if (staleSwitchingRegistration) {
    if (confirmRemoval) {
      const confirmed = await prompts.confirm({
        message: `确认清理缺失 Profile 的自定义切换 Provider ${normalizedId}？`,
        initialValue: false,
      });
      if (prompts.isCancel(confirmed) || confirmed !== true) return;
    }
    removeCustomPrimaryProviderSwitchingProfile(environment, normalizedId);
    let backupCleaned = true;
    try {
      removePrimaryProviderBackupCandidate(normalizedId, environment);
    } catch {
      backupCleaned = false;
    }
    output.write(`已清理缺失 Profile 的自定义切换 Provider ${normalizedId}。\n`);
    if (!backupCleaned) {
      output.write(
        "缺失 Profile 的注册项已清理，但私有备份无法安全检查或清理；"
        + "请修复私有备份权限后再次执行删除。\n",
      );
    }
    writeCliRemediationRestartAll();
    return;
  }
  const snapshot = await readCodexUserConfigSnapshot(environment, { createClient });
  const config = record(snapshot.config);
  const providers = record(config.model_providers);
  const candidates = listCustomPrimaryProviderCandidates(providers);
  const backup = readPrimaryProviderBackup(environment);
  const switching = loadConfiguredCustomSwitchingModelProviders(environment)
    .find(({ id }) => id === normalizedId);
  const configured = candidates.includes(normalizedId);
  const backedUp = Object.prototype.hasOwnProperty.call(backup, normalizedId);
  if (!configured && !backedUp && switching === undefined) {
    throw new Error(`未找到自定义主 Provider：${normalizedId}；可用 codexc primary-provider list 查看候选`);
  }
  const provider = record(
    configured
      ? providers[normalizedId]
      : backedUp
        ? backup[normalizedId]
        : { name: switching?.name, base_url: switching?.baseUrl },
  );
  if (confirmRemoval) {
    const name = optionalString(provider.name) ?? normalizedId;
    const baseUrl = typeof provider.base_url === "string" ? provider.base_url : "";
    const confirmed = await prompts.confirm({
      message: `确认删除 ${name}（${normalizedId}）· ${baseUrl}？此操作无法撤销。`,
      initialValue: false,
    });
    if (prompts.isCancel(confirmed) || confirmed !== true) {
      return;
    }
  }
  if (switching !== undefined) {
    removeCustomPrimaryProviderSwitchingProfile(environment, normalizedId);
    let backupCleaned = true;
    try {
      removePrimaryProviderBackupCandidate(normalizedId, environment);
    } catch {
      backupCleaned = false;
    }
    output.write(`已删除自定义切换 Provider ${normalizedId}，保留官方 OpenAI 主 Provider。\n`);
    if (!backupCleaned) {
      output.write(
        `自定义切换 Provider ${normalizedId} 已删除，但同名私有备份清理失败；`
        + "请修复私有备份权限后再次执行删除。\n",
      );
    }
    writeCliRemediationRestartAll();
    return;
  }
  if (!configured) {
    removePrimaryProviderBackupCandidate(normalizedId, environment);
    output.write(`已删除备份中的自定义主 Provider：${normalizedId}。\n`);
    return;
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
  const backupCleaned = await writeEditsRemovingBackupCandidate({
    id: normalizedId,
    environment,
    edits,
    expectedVersion: snapshot.version,
    createClient,
  });
  output.write(
    activeId === normalizedId
      ? `已删除自定义主 Provider ${normalizedId} 并恢复官方 OpenAI 主 Provider。\n`
      : `已删除自定义主 Provider 候选：${normalizedId}。\n`,
  );
  if (!backupCleaned) {
    writeBackupCleanupWarning(output, normalizedId);
  }
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
      message: "自定义 Responses Provider",
      showInstructions: false,
      options: [
        { value: "add", label: "新增", hint: "新增固定或切换 Provider" },
        { value: "edit", label: "编辑", hint: "修改已有 Provider；Provider ID 保持不变" },
        { value: "list", label: "列表", hint: "查看主实例、切换 Provider、固定候选与备份" },
        { value: "switch", label: "设为固定主 Provider", hint: "切换模式将转换为固定模式" },
        { value: "official", label: "恢复官方主 Provider", hint: "固定候选移入备份；切换 Provider 保持启用" },
        { value: "remove", label: "删除", hint: "删除 Provider；删除当前固定主 Provider 时恢复官方" },
        ...(allowBack
          ? [{ value: "back", label: "返回", hint: "返回模型与提供商设置" }]
          : []),
      ],
    });
    if (prompts.isCancel(action) || action === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
    if (action === "add") {
      const result = await addPrimaryProvider({
        environment,
        output,
        prompts,
        createClient,
      });
      if (result === undefined || result?.action !== undefined) {
        continue;
      }
      output.write("已保存自定义 Provider；可继续选择其他操作或返回。\n");
      continue;
    }
    if (action === "edit") {
      const id = await selectCustomPrimaryCandidate({
        environment,
        output,
        prompts,
        createClient,
        message: "编辑哪个自定义 Provider？",
        includeBackup: true,
        backupHint: "备份中，可直接编辑",
        switchingHint: "独立切换模式",
        allowUnreadableBackupFallback: true,
      });
      if (id === undefined) {
        continue;
      }
      const result = await runCustomPrimaryProviderSetup({
        environment,
        output,
        prompts,
        createClient,
        providerId: id,
      });
      if (result !== undefined && result?.action === undefined) {
        output.write(`已保存自定义 Provider：${id}。\n`);
      }
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
          ? "将哪个自定义 Provider 设为固定主 Provider？"
          : "删除哪个自定义 Provider？",
        includeBackup: true,
        backupHint: action === "switch" ? "从备份恢复" : "备份中，可直接删除",
        switchingHint: action === "switch"
          ? "独立切换模式，将转为固定模式"
          : "独立切换模式",
      });
      if (id === undefined) {
        continue;
      }
      if (action === "switch") {
        const switchingProvider = loadConfiguredCustomSwitchingModelProviders(environment)
          .find(({ id: providerId }) => providerId === id);
        if (switchingProvider !== undefined) {
          const confirmed = await prompts.confirm({
            message: `${switchingProvider.name}（${id}）当前是独立切换 Provider。`
              + "确认删除独立 Profile，并转换为固定主 Provider？",
            initialValue: false,
          });
          if (prompts.isCancel(confirmed) || confirmed !== true) {
            output.write("已取消，Provider 模式未改变。\n");
            continue;
          }
        }
        await switchPrimaryProvider(id, undefined, { environment, output, createClient });
      } else {
        await removePrimaryProvider(id, {
          environment,
          output,
          prompts,
          confirmRemoval: true,
          createClient,
        });
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
  backupHint = "从备份恢复",
  switchingHint,
  allowUnreadableBackupFallback = false,
}) {
  const snapshot = await readCodexUserConfigSnapshot(environment, { createClient });
  const configured = listCustomPrimaryProviderCandidates(
    record(snapshot.config.model_providers),
  );
  const switching = loadConfiguredCustomSwitchingModelProviders(environment);
  let backup = {};
  if (includeBackup) {
    try {
      backup = readPrimaryProviderBackup(environment);
    } catch (error) {
      if (!allowUnreadableBackupFallback || configured.length === 0) throw error;
      output.write("私有备份无法读取，仅显示当前配置候选。\n");
    }
  }
  const backupIds = includeBackup
    ? Object.keys(backup).filter((id) => !configured.includes(id))
    : [];
  const switchingIds = switching.map(({ id }) => id)
    .filter((id) => !configured.includes(id) && !backupIds.includes(id));
  const candidates = [...configured, ...switchingIds, ...backupIds];
  if (candidates.length === 0) {
    output.write(
      includeBackup
        ? "暂无自定义 Provider 或备份，请先选择“新增”。\n"
        : "暂无自定义 Provider，请先选择“新增”。\n",
    );
    return undefined;
  }
  const details = candidates.map((candidate) => {
    const switchingProvider = switching.find(({ id }) => id === candidate);
    const provider = record(
      record(snapshot.config.model_providers)[candidate]
      ?? backup[candidate]
      ?? (switchingProvider === undefined
        ? undefined
        : { name: switchingProvider.name, base_url: switchingProvider.baseUrl }),
    );
    return {
      id: candidate,
      name: optionalString(provider.name) ?? candidate,
      baseUrl: typeof provider.base_url === "string" ? provider.base_url : "",
    };
  });
  const id = await prompts.select({
    message,
    showInstructions: false,
    options: details.map(({ id: candidate, name, baseUrl }) => {
      const label = name === candidate ? candidate : `${name}（${candidate}）`;
      return {
        value: candidate,
        label: `${label} · ${baseUrl}`,
        ...(backupIds.includes(candidate)
          ? { hint: backupHint }
          : switchingHint !== undefined && switchingIds.includes(candidate)
            ? { hint: switchingHint }
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
