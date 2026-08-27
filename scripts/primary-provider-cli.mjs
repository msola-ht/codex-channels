import * as clackPrompts from "@clack/prompts";
import { pathToFileURL } from "node:url";

import {
  listCustomPrimaryProviderCandidates,
  loadConfiguredCustomSwitchingModelProviders,
  readPrimaryProviderBackup,
} from "../runtime/model-provider-runtime.mjs";
import {
  writeCliMessage,
  writeCliRemediationRestartAll,
} from "../runtime/cli-presentation.mjs";
import {
  createCodexUserConfigClient,
  readCodexUserConfigSnapshot,
} from "./codex-user-config.mjs";
import { runCustomPrimaryProviderSetup } from "./custom-primary-provider-setup.mjs";
import { loadModelProviderManagementState } from "./model-provider-management.mjs";
import {
  applyPrimaryProviderRemoval,
  applyPrimaryProviderSwitch,
  previewPrimaryProviderRemoval,
} from "./primary-provider-management.mjs";
import { primaryProviderUsage } from "./primary-provider-usage.mjs";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
  json = false,
} = {}) {
  const state = await loadModelProviderManagementState({
    environment,
    readUserConfig: (selectedEnvironment) => readCodexUserConfigSnapshot(
      selectedEnvironment,
      { createClient },
    ),
    loadManagedProviders: () => [],
    loadAgentStatus: () => ({ externalRoleConfigured: false }),
  });
  const activeId = state.primary.id;
  const switchingProviders = state.customProviders.switchingProviders;
  const activeLabel = switchingProviders.length > 0
    ? `OpenAI 官方 + ${switchingProviders.map(({ id }) => id).join("、")} · 自定义切换模式`
    : state.primary.mode === "official"
      ? "OpenAI 官方"
      : state.primary.mode === "exclusive"
        ? `${state.primary.displayName} · ${state.primary.kind === "managed" ? "受管" : "自定义"}固定模式`
        : state.primary.mode === "backup"
          ? `${activeId} · 自定义（备份中）`
          : `${activeId}（未在候选列表中）`;

  if (json) {
    output.write(`${JSON.stringify({
      active: {
        id: activeId,
        label: activeLabel,
        mode: switchingProviders.length > 0
          ? "switching"
          : state.primary.mode,
      },
      fixedCandidates: state.customProviders.fixedCandidates.map((provider) => ({
        id: provider.id,
        name: provider.displayName,
        baseUrl: provider.baseUrl,
        active: provider.active,
      })),
      switchingProviders: switchingProviders.map((provider) => ({
        id: provider.id,
        name: provider.displayName,
        baseUrl: provider.baseUrl,
        profileName: provider.profileName,
      })),
      backupCandidates: state.customProviders.backupCandidates.map((provider) => ({
        id: provider.id,
        name: provider.displayName,
        baseUrl: provider.baseUrl,
        active: provider.active,
      })),
    })}\n`);
    return;
  }

  output.write("\nCodex Connect 自定义 Responses Provider\n");
  output.write(`当前主实例：${activeLabel}\n`);
  if (state.customProviders.fixedCandidates.length === 0) {
    output.write("自定义固定候选：无\n");
  } else {
    output.write("自定义固定候选：\n");
    for (const provider of state.customProviders.fixedCandidates) {
      const active = provider.active
          ? " · 当前固定模式"
          : "";
      output.write(`- ${provider.displayName}（${provider.id}）· ${provider.baseUrl}${active}\n`);
    }
  }
  if (switchingProviders.length > 0) {
    output.write("已启用的自定义切换 Provider：\n");
    for (const provider of switchingProviders) {
      output.write(`- ${provider.displayName}（${provider.id}）· ${provider.baseUrl} · Profile ${provider.profileName}\n`);
    }
  }
  if (state.customProviders.backupCandidates.length > 0) {
    output.write("备份候选（已从 config 清理，可切回）：\n");
    for (const provider of state.customProviders.backupCandidates) {
      output.write(`- ${provider.displayName}（${provider.id}）· ${provider.baseUrl}\n`);
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
  const result = await applyPrimaryProviderSwitch(
    { providerId, model },
    { environment, createClient },
  );
  if (result.effects.restoresFromBackup) {
    output.write(`从备份恢复自定义主 Provider：${result.target.id}。\n`);
  }
  if (result.effects.removesTopLevelBaseUrl) {
    output.write(
      result.target.source === "official"
        ? "已移除与官方主 Provider 冲突的顶层 openai_base_url。\n"
        : "已移除与自定义主 Provider 冲突的顶层 openai_base_url。\n",
    );
  }
  if (result.target.source === "official") {
    output.write(
      result.effects.backedUpProviderIds.length === 0
        ? "已切换到官方 OpenAI 主 Provider（未运行 codex login，官方凭据保留）。\n"
        : "已切换到官方 OpenAI 主 Provider（未运行 codex login，官方凭据保留）；"
          + `自定义候选已移入私有备份：${result.effects.backedUpProviderIds.join("、")}。\n`,
    );
  } else {
    output.write(`已设为固定主 Provider：${result.target.id}。\n`);
  }
  if (result.warnings.some(({ code }) => code === "backup-cleanup-failed")) {
    writeBackupCleanupWarning(output, result.target.id);
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
  const preview = await previewPrimaryProviderRemoval(
    { providerId },
    { environment, createClient },
  );
  if (confirmRemoval) {
    const confirmed = await prompts.confirm({
      message: preview.target.state === "stale-switching"
        ? `确认清理缺失 Profile 的自定义切换 Provider ${preview.target.id}？`
        : `确认删除 ${preview.target.displayName}（${preview.target.id}）· ${preview.target.baseUrl}？此操作无法撤销。`,
      initialValue: false,
    });
    if (prompts.isCancel(confirmed) || confirmed !== true) {
      return;
    }
  }
  const result = await applyPrimaryProviderRemoval(
    { providerId },
    { environment, createClient, preview },
  );
  if (result.target.state === "stale-switching") {
    output.write(`已清理缺失 Profile 的自定义切换 Provider ${result.target.id}。\n`);
  } else if (result.target.state === "switching") {
    output.write(`已删除自定义切换 Provider ${result.target.id}，保留官方 OpenAI 主 Provider。\n`);
  } else if (result.target.state === "backup") {
    output.write(`已删除备份中的自定义主 Provider：${result.target.id}。\n`);
  } else {
    output.write(
      result.effects.restoresOfficial
        ? `已删除自定义主 Provider ${result.target.id} 并恢复官方 OpenAI 主 Provider。\n`
        : `已删除自定义主 Provider 候选：${result.target.id}。\n`,
    );
  }
  if (result.warnings.some(({ code }) => code === "backup-cleanup-failed")) {
    if (result.target.state === "stale-switching") {
      output.write(
        "缺失 Profile 的注册项已清理，但私有备份无法安全检查或清理；"
        + "请修复私有备份权限后再次执行删除。\n",
      );
    } else if (result.target.state === "switching") {
      output.write(
        `自定义切换 Provider ${result.target.id} 已删除，但同名私有备份清理失败；`
        + "请修复私有备份权限后再次执行删除。\n",
      );
    } else {
      writeBackupCleanupWarning(output, result.target.id);
    }
  }
  if (result.activation === "restart-all") {
    writeCliRemediationRestartAll();
  }
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
          ? [{ value: "back", label: "返回", hint: "返回第三方 Provider 设置" }]
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
    const json = rest.length === 1 && rest[0] === "--json";
    if (rest.length > 0 && !json) {
      throw new Error("用法：codexc primary-provider list [--json]");
    }
    await listPrimaryProviders({ environment, output, createClient, json });
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
