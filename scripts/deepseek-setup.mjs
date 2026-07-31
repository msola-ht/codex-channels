import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parse, stringify } from "smol-toml";
import * as clackPrompts from "@clack/prompts";

export const deepseekSetupScriptUrl =
  "https://cdn.deepseek.com/api-docs/codex-deepseek-setup.sh";
const providerId = "deepseek";
const supportedModel = "deepseek-v4-flash";
const maximumScriptBytes = 2 * 1024 * 1024;

export async function runDeepseekSetup({
  environment = process.env,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  prompter,
  prompts = clackPrompts,
} = {}) {
  const prompt = prompter ?? createHiddenPrompter(prompts);
  try {
    output.write("\nCodex Connect DeepSeek Setup\n\n");
    output.write("1. OpenAI + DeepSeek 切换模式（保留 OpenAI 默认）\n");
    output.write("2. 仅 DeepSeek 固定模式（原生 Codex 也默认使用 DeepSeek）\n");
    output.write("3. 恢复安装前的 Codex 配置\n");
    const choice = await askChoice(prompt, "请选择 [1-3]", 3);
    const codexHome = resolve(environment.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    const configPath = join(codexHome, "config.toml");
    const profilePath = join(codexHome, "deepseek.config.toml");
    const gatewayProfilePath = join(codexHome, "codex-connect-deepseek.config.toml");
    const catalogPath = join(codexHome, "deepseek.models.json");
    const manifestPath = join(codexHome, "deepseek.models.manifest.json");
    const backupDirectory = join(codexHome, "backup-codex-connect-deepseek");
    const backupPath = join(backupDirectory, "config.toml");
    const profileBackupPath = join(backupDirectory, "deepseek.config.toml");
    const gatewayProfileBackupPath = join(
      backupDirectory,
      "codex-connect-deepseek.config.toml",
    );
    const backupStatePath = join(backupDirectory, "state.json");
    if (choice === "3") {
      output.write("恢复会覆盖 DeepSeek 安装后对 ~/.codex/config.toml 做的其他修改。\n");
      if (!await prompt.confirm("确认恢复首次安装前的配置？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
      return restoreInitialConfig({
        configPath,
        profilePath,
        gatewayProfilePath,
        catalogPath,
        manifestPath,
        backupPath,
        profileBackupPath,
        gatewayProfileBackupPath,
        backupStatePath,
        output,
      });
    }
    const mode = choice === "1" ? "switching" : "exclusive";
    if (mode === "switching") {
      output.write(
        "\n切换模式不修改 ~/.codex/config.toml；DeepSeek 模型、Provider 与 API Key 全部保存在独立 Profile。\n",
      );
    }
    if (mode === "exclusive") {
      output.write("\n固定模式会修改 ~/.codex/config.toml，并将 DeepSeek API Key 写入该 0600 文件。\n");
      if (!await prompt.confirm("确认继续并先备份原配置？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
    }
    const apiKey = await askApiKey(prompt);

    const downloaded = await downloadDeepseekCatalog(fetchImpl);
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await preserveInitialConfig({
      configPath,
      profilePath,
      gatewayProfilePath,
      backupPath,
      profileBackupPath,
      gatewayProfileBackupPath,
      backupStatePath,
    });
    const { configContent, profileContent, gatewayProfileContent } = await buildCodexConfig({
      backupPath,
      backupStatePath,
      catalogPath,
      apiKey,
      mode,
    });
    await atomicWrite(catalogPath, `${JSON.stringify(downloaded.catalog, null, 2)}\n`);
    await atomicWrite(manifestPath, `${JSON.stringify({
      source: deepseekSetupScriptUrl,
      sha256: downloaded.sha256,
      downloadedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await replaceOptionalFile(configPath, configContent);
    await replaceOptionalFile(profilePath, profileContent);
    await replaceOptionalFile(gatewayProfilePath, gatewayProfileContent);
    if (mode === "switching") {
      output.write(`\nOpenAI 基础配置保持不变：${configPath}\n`);
      output.write(`DeepSeek CLI Profile 已保存：${profilePath}\n`);
    } else {
      output.write(`\nDeepSeek 固定配置已保存：${configPath}\n`);
    }
    output.write(`模型目录已从官方脚本下载：${catalogPath}\n`);
    output.write(mode === "switching"
      ? "原生 Codex 使用 OpenAI：codex；使用 DeepSeek：codex --profile deepseek\n共享 TUI：codexc remote；DeepSeek 共享 TUI：codexc remote --profile deepseek\n"
      : "原生 Codex 和 Gateway 将默认使用 deepseek-v4-flash。\n");
    output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
    return {
      mode,
      configPath,
      profilePath,
      gatewayProfilePath,
      catalogPath,
      backupPath,
    };
  } finally {
    prompt.close();
  }
}

export async function downloadDeepseekCatalog(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node.js 环境不支持 fetch");
  }
  const response = await fetchImpl(deepseekSetupScriptUrl, {
    headers: { accept: "text/plain" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`DeepSeek 官方脚本下载失败：HTTP ${response.status}`);
  }
  if (response.url && response.url !== deepseekSetupScriptUrl) {
    throw new Error("DeepSeek 官方脚本下载发生了未允许的重定向");
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maximumScriptBytes) {
    throw new Error("DeepSeek 官方脚本超过允许大小");
  }
  const script = await response.text();
  if (Buffer.byteLength(script) > maximumScriptBytes) {
    throw new Error("DeepSeek 官方脚本超过允许大小");
  }
  const catalog = extractDeepseekCatalog(script);
  return {
    catalog,
    sha256: createHash("sha256").update(script).digest("hex"),
  };
}

export function extractDeepseekCatalog(script) {
  const matches = [...script.matchAll(
    /<<'CODEX_MODELS_JSON'\s*\r?\n([\s\S]*?)\r?\nCODEX_MODELS_JSON(?:\r?\n|$)/gu,
  )];
  if (matches.length !== 1) {
    throw new Error("DeepSeek 官方脚本中的模型目录标记无效");
  }
  let catalog;
  try {
    catalog = JSON.parse(matches[0][1]);
  } catch {
    throw new Error("DeepSeek 官方模型目录不是有效 JSON");
  }
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error("DeepSeek 官方模型目录缺少 models");
  }
  const flash = catalog.models.find((model) => model?.slug === supportedModel);
  if (!flash || typeof flash !== "object") {
    throw new Error(`DeepSeek 官方模型目录缺少 ${supportedModel}`);
  }
  return catalog;
}

async function buildCodexConfig({
  backupPath,
  backupStatePath,
  catalogPath,
  apiKey,
  mode,
}) {
  let document = {};
  let originalContent;
  try {
    const state = JSON.parse(await readFile(backupStatePath, "utf8"));
    if (state.originalConfigExisted === true) {
      originalContent = await readFile(backupPath, "utf8");
      document = parse(originalContent);
    } else if (state.originalConfigExisted !== false) {
      throw new Error("invalid backup state");
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      // TOML 解析错误可能包含带 API Key 的原始配置行，不能作为 cause 暴露。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("现有 Codex config.toml 无法读取或解析，未修改配置");
    }
  }
  const provider = {
    name: "deepseek",
    base_url: "https://api.deepseek.com/",
    wire_api: "responses",
    requires_openai_auth: false,
    experimental_bearer_token: apiKey,
  };
  const providerLayer = {
    model_providers: { [providerId]: provider },
  };
  const profile = {
    model: supportedModel,
    model_provider: providerId,
    model_reasoning_effort: "high",
    model_catalog_json: catalogPath,
    ...providerLayer,
  };
  if (mode === "switching") {
    if (document.profile === providerId || table(document.profiles).deepseek !== undefined) {
      throw new Error(
        "安装前的 Codex config.toml 已占用旧式 deepseek profile；请先手工迁移或改名",
      );
    }
    if (table(document.model_providers).deepseek !== undefined) {
      throw new Error(
        "安装前的 Codex config.toml 已存在 deepseek Provider；请先手工移除或改名",
      );
    }
    return {
      configContent: originalContent,
      profileContent: stringify(profile),
      gatewayProfileContent: stringify({
        version: 1,
        provider: providerId,
        mode: "switching",
      }),
    };
  }

  document.model_providers = table(document.model_providers);
  document.model_providers[providerId] = provider;
  if (document.profile === providerId) {
    delete document.profile;
  }
  const profiles = table(document.profiles);
  delete profiles.deepseek;
  if (Object.keys(profiles).length === 0) {
    delete document.profiles;
  } else {
    document.profiles = profiles;
  }
  Object.assign(document, {
    model: supportedModel,
    model_provider: providerId,
    model_reasoning_effort: "high",
    model_catalog_json: catalogPath,
  });
  delete document.preferred_auth_method;
  delete document.forced_login_method;
  return {
    configContent: stringify(document),
    profileContent: undefined,
    gatewayProfileContent: stringify({
      version: 1,
      provider: providerId,
      mode: "exclusive",
    }),
  };
}

async function preserveInitialConfig({
  configPath,
  profilePath,
  gatewayProfilePath,
  backupPath,
  profileBackupPath,
  gatewayProfileBackupPath,
  backupStatePath,
}) {
  let state;
  try {
    state = JSON.parse(await readFile(backupStatePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (state === undefined) {
    state = {};
    state.originalConfigExisted = await backupIfPresent(configPath, backupPath);
  } else if (typeof state.originalConfigExisted !== "boolean") {
    throw new Error("Codex 初始配置备份状态无效");
  }
  if (typeof state.originalProfileExisted !== "boolean") {
    state.originalProfileExisted = await backupIfPresent(profilePath, profileBackupPath);
  }
  if (typeof state.originalGatewayProfileExisted !== "boolean") {
    state.originalGatewayProfileExisted = await backupIfPresent(
      gatewayProfilePath,
      gatewayProfileBackupPath,
    );
  }
  await atomicWrite(backupStatePath, `${JSON.stringify(state)}\n`);
}

async function backupIfPresent(sourcePath, backupPath) {
  try {
    await atomicWrite(backupPath, await readFile(sourcePath));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function restoreInitialConfig({
  configPath,
  profilePath,
  gatewayProfilePath,
  catalogPath,
  manifestPath,
  backupPath,
  profileBackupPath,
  gatewayProfileBackupPath,
  backupStatePath,
  output,
}) {
  let state;
  try {
    state = JSON.parse(await readFile(backupStatePath, "utf8"));
  } catch {
    throw new Error("未找到可恢复的 Codex 初始配置");
  }
  if (state.originalConfigExisted === true) {
    await atomicWrite(configPath, await readFile(backupPath));
  } else if (state.originalConfigExisted === false) {
    await removeFile(configPath);
  } else {
    throw new Error("Codex 初始配置备份状态无效");
  }
  if (state.originalProfileExisted === true) {
    await atomicWrite(profilePath, await readFile(profileBackupPath));
  } else if (state.originalProfileExisted === false) {
    await removeFile(profilePath);
  }
  if (state.originalGatewayProfileExisted === true) {
    await atomicWrite(gatewayProfilePath, await readFile(gatewayProfileBackupPath));
  } else if (state.originalGatewayProfileExisted === false) {
    await removeFile(gatewayProfilePath);
  }
  await removeFile(catalogPath);
  await removeFile(manifestPath);
  output.write("已恢复安装前的 Codex 配置；备份目录保留以便审计。\n");
  output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
  return {
    mode: "restored",
    configPath,
    profilePath,
    gatewayProfilePath,
    catalogPath,
    backupPath,
  };
}

async function replaceOptionalFile(path, content) {
  if (content === undefined) {
    await removeFile(path);
    return;
  }
  try {
    if (await readFile(path, "utf8") === content) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(path, content);
}

async function removeFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

async function askChoice(prompt, label, maximum) {
  while (true) {
    const choice = await prompt.ask(label);
    if (new RegExp(`^[1-${maximum}]$`, "u").test(choice)) return choice;
  }
}

async function askApiKey(prompt) {
  while (true) {
    const apiKey = await prompt.secret("DeepSeek API Key（以 sk- 开头）");
    if (/^sk-[^\s"]+$/u.test(apiKey)) return apiKey;
  }
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function createHiddenPrompter(prompts) {
  return {
    ask: async () => requirePromptValue(prompts, await prompts.select({
      message: "选择 DeepSeek 安装模式",
      options: [
        { value: "1", label: "OpenAI + DeepSeek 切换模式" },
        { value: "2", label: "仅 DeepSeek 固定模式" },
        { value: "3", label: "恢复安装前配置" },
      ],
    })),
    secret: async (label) => requirePromptValue(
      prompts,
      await prompts.password({ message: label }),
    ),
    confirm: async (label, initialValue) => requirePromptValue(
      prompts,
      await prompts.confirm({ message: label, initialValue }),
    ),
    close: () => undefined,
  };
}

function requirePromptValue(prompts, value) {
  if (prompts.isCancel(value)) {
    throw new Error("DeepSeek Setup 已取消");
  }
  return value;
}
