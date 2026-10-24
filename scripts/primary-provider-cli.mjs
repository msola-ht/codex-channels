import { recoverResponsesProviderCatalog } from "./responses-provider-recovery.mjs";
import { isCommandHelp } from "./cli-help.mjs";
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
  previewPrimaryProviderSwitch,
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
  });
  const activeId = state.primary.id;
  const switchingProviders = state.customProviders.switchingProviders;
  const activeLabel = switchingProviders.length > 0
    ? `OpenAI 官方 + ${switchingProviders.map(({ id }) => id).join("、")} · 自定义切换模式`
    : state.primary.mode === "official"
      ? state.officialAuth?.authenticated === false
        ? "OpenAI 官方（未登录）"
        : "OpenAI 官方"
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
        ...(provider.upstreamWireApi === undefined ? {} : { upstreamWireApi: provider.upstreamWireApi }),
      })),
      switchingProviders: switchingProviders.map((provider) => ({
        id: provider.id,
        name: provider.displayName,
        baseUrl: provider.baseUrl,
        profileName: provider.profileName,
        upstreamWireApi: provider.upstreamWireApi,
      })),
      backupCandidates: state.customProviders.backupCandidates.map((provider) => ({
        id: provider.id,
        name: provider.displayName,
        baseUrl: provider.baseUrl,
        active: provider.active,
        ...(provider.upstreamWireApi === undefined ? {} : { upstreamWireApi: provider.upstreamWireApi }),
      })),
    })}\n`);
    return;
  }

  output.write("\nCodex Connect 自定义提供商（官方模型目录 / 自定义模型目录）\n");
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
    "\n设为固定主 Provider：codexc provider switch <Provider ID>；"
    + "新增：codexc provider add（官方模型目录）或 codexc provider add --custom-models（自定义模型目录）；"
    + "编辑：codexc setup → 模型与提供商 → 第三方提供商 → 自定义提供商 → 编辑。\n",
  );
}

export async function switchPrimaryProvider(
  providerId,
  model,
  {
    environment = process.env,
    output = process.stdout,
    prompts = clackPrompts,
    confirm = false,
    createClient = createCodexUserConfigClient,
  } = {},
) {
  let switchPreview;
  if (confirm) {
    switchPreview = await previewPrimaryProviderSwitch(
      { providerId, model },
      { environment, createClient },
    );
    const confirmed = await prompts.confirm({
      message: switchConfirmationMessage(switchPreview),
      initialValue: false,
    });
    if (prompts.isCancel(confirmed) || confirmed !== true) {
      output.write("已取消，Provider 模式未改变。\n");
      return { action: "cancelled" };
    }
  }
  const result = await applyPrimaryProviderSwitch(
    { providerId, model },
    { environment, createClient, switchPreview },
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

function switchConfirmationMessage({ target, effects }) {
  if (target.id === "openai") {
    const modelChange = effects.clearsCustomModel ? "清空自定义模式的顶层 model" : target.model
      ? `model 设为 ${target.model}` : "保留当前顶层 model";
    return `将恢复 OpenAI 官方主 Provider（model_provider 设为 openai；${modelChange}）。确认继续？`;
  }
  const label = `${target.displayName}（${target.id}）`;
  if (target.source === "switching") {
    return `将把主实例切换到 ${label}，移除其独立切换 Profile，并改写 Codex 主配置的 model_provider / model。确认继续？`;
  }
  if (target.source === "backup") {
    return `将把主实例切换到 ${label}，从备份恢复，并改写 Codex 主配置的 model_provider / model。确认继续？`;
  }
  return `将把主实例切换到 ${label}，并改写 Codex 主配置（model_provider / model）。确认继续？`;
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
  if (result.target.state === "orphan-catalog") {
    output.write(`Provider ${result.target.id} 配置已不存在，已执行其精确残留清理。\n`);
  } else if (result.target.state === "stale-switching") {
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
  if (result.warnings.some(({ code }) => code === "credential-cleanup-failed")) {
    output.write(`Provider ${result.target.id} 已删除，但私有凭据版本无法安全检查或清理，文件保持保留；请检查其 primary-credentials 目录。\n`);
  }
  if (result.warnings.some(({ code }) => code === "catalog-cleanup-failed")) {
    output.write(`Provider ${result.target.id} 配置已删除，但模型目录或恢复材料清理未完成；请修复对应文件权限或类型后再次运行 codexc provider remove ${result.target.id}。\n`);
  }
  if (result.warnings.some(({ code }) => code === "metadata-cleanup-failed")) {
    output.write(`Provider ${result.target.id} 配置已删除，但 provider.json 元数据清理未完成；请修复对应文件权限或类型后再次运行 codexc provider remove ${result.target.id}。\n`);
  }
  if (result.warnings.some(({ code }) => code === "lock-cleanup-failed")) {
    output.write(`Provider ${result.target.id} 删除处理已完成，但管理锁释放失败；请检查锁文件权限和持有进程，不要重复删除。\n`);
  }
  if (result.activation === "restart-all") {
    writeCliRemediationRestartAll();
  }
  return result;
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
  catalogKind,
} = {}) {
  let lastAction;
  while (true) {
    const action = await prompts.select({
      message: catalogKind === "official" ? "Codex 兼容 Provider" : "自定义提供商",
      showInstructions: false,
      initialValue: lastAction,
      options: [
        { value: "list", label: "查看提供商", hint: "查看当前主实例、切换模式、固定候选与备份" },
        { value: "add", label: "添加提供商", hint: catalogKind === undefined ? "先选择模型目录，再选择运行模式" : "选择固定模式或切换模式" },
        { value: "edit", label: "编辑提供商", hint: "连接、凭据与运行模式；自定义目录还可管理模型" },
        { value: "switch", label: "设为固定主提供商", hint: "切换模式将转换为固定模式" },
        { value: "official", label: "恢复 OpenAI 为主提供商", hint: "固定候选移入备份；切换提供商保持启用" },
        ...(catalogKind !== "official" ? [{ value: "recover", label: "恢复未完成的模型目录保存", hint: "自定义目录；先停止服务并核对当前配置" }] : []),
        { value: "remove", label: "移除本地提供商配置", hint: "移除当前固定主提供商时恢复 OpenAI" },
        ...(allowBack
          ? [{ value: "back", label: "返回", hint: "返回第三方提供商" }]
          : []),
      ],
    });
    if (prompts.isCancel(action) || action === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
    lastAction = action;
    if (action === "recover") {
      const id = await prompts.text({ message: "自定义提供商 ID" });
      if (prompts.isCancel(id)) continue;
      const recovery = await prompts.select({ message: "选择恢复方式", options: [{ value: "rollback", label: "回滚上一目录" }, { value: "keep", label: "保留新目录" }] });
      if (prompts.isCancel(recovery)) continue;
      await runPrimaryProviderCli(["recover", String(id), String(recovery)], { environment, output, prompts, createClient });
      continue;
    }
    if (action === "add") {
      let lastCatalogKind;
      while (true) {
        const selectedCatalogKind = catalogKind ?? await prompts.select({
          message: "添加提供商使用哪个模型目录？",
          showInstructions: false,
          initialValue: lastCatalogKind,
          options: [
            { value: "official", label: "Codex 官方模型目录", hint: "上游模型 ID 必须在 Codex 官方目录中；Responses 接口" },
            { value: "custom", label: "自定义模型目录", hint: "自行声明模型与能力；Responses 或 Chat Completions 接口" },
            { value: "back", label: "返回", hint: "返回自定义提供商" },
          ],
        });
        if (prompts.isCancel(selectedCatalogKind) || selectedCatalogKind === "back") break;
        lastCatalogKind = selectedCatalogKind;
        const result = await addPrimaryProvider({
          catalogKind: selectedCatalogKind,
          environment,
          output,
          prompts,
          createClient,
        });
        if (result === undefined || result?.action !== undefined) {
          if (catalogKind === undefined) continue;
          break;
        }
        output.write("已保存自定义 Provider；可继续选择其他操作或返回。\n");
        break;
      }
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
      await switchPrimaryProvider("openai", undefined, {
        environment,
        output,
        prompts,
        createClient,
        confirm: true,
      });
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
        await switchPrimaryProvider(id, undefined, {
          environment,
          output,
          prompts,
          createClient,
          confirm: true,
        });
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
  if (args.length === 0 || isCommandHelp(args, [[], ["add"], ["list"], ["switch"], ["remove"], ["recover"]], primaryProviderUsage)) {
    output.write(`${primaryProviderUsage}\n`);
    return;
  }
  if (subcommand === "list") {
    const json = rest.length === 1 && rest[0] === "--json";
    if (rest.length > 0 && !json) {
      throw new Error("用法：codexc provider list [--json]");
    }
    await listPrimaryProviders({ environment, output, createClient, json });
    return;
  }
  if (subcommand === "recover") {
    const [id, action, yes] = rest;
    if (!id || !["keep", "rollback"].includes(action) || rest.length > 3 || (yes !== undefined && yes !== "--yes")) throw new Error("用法：codexc provider recover <Provider ID> <keep|rollback> [--yes]");
    if (yes !== "--yes") {
      const confirmed = await prompts.confirm({ message: `恢复 ${id} 模型目录及对应配置：${action === "keep" ? "保留新目录" : "回滚上一目录"}？请先停止对应服务并核对配置；旧上下文联动事务会恢复其记录的全部关联目录。`, initialValue: false });
      if (prompts.isCancel(confirmed) || confirmed !== true) return;
    }
    await recoverResponsesProviderCatalog(id, action, environment);
    output.write(`已恢复 ${id} 模型目录，请运行 codexc restart all。\n`);
    return;
  }
  if (subcommand === "add") {
    if (rest.length > 1 || (rest[0] !== undefined && rest[0] !== "--custom-models")) {
      throw new Error("用法：codexc provider add [--custom-models]");
    }
    await addPrimaryProvider({ environment, output, prompts, createClient, catalogKind: args[1] === "--custom-models" ? "custom" : "official" });
    return;
  }
  if (subcommand === "switch") {
    const yes = rest[rest.length - 1] === "--yes";
    const positional = yes ? rest.slice(0, -1) : rest;
    if (
      positional.length === 0
      || positional.length > 2
      || (positional[0] === "openai" && positional.length !== 1)
    ) {
      throw new Error("用法：codexc provider switch <Provider ID> [模型] [--yes]");
    }
    await switchPrimaryProvider(positional[0], positional[1], {
      environment,
      output,
      prompts,
      createClient,
      confirm: !yes,
    });
    return;
  }
  if (subcommand === "remove") {
    if (rest.length !== 1) {
      throw new Error("用法：codexc provider remove <Provider ID>");
    }
    const result = await removePrimaryProvider(rest[0], { environment, output, createClient });
    if (result?.warnings.length > 0) {
      throw new Error("Provider 配置已删除，但清理未全部完成；请按上方提示核对已完成操作与残留状态。");
    }
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
