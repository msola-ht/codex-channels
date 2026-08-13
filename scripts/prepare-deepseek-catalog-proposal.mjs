import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  deepseekSetupScriptUrl,
  downloadDeepseekCatalog,
} from "./deepseek-setup.mjs";

const baselineSchemaVersion = 1;
const maximumModels = 100;
const maximumTextLength = 2_000;
const slugPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export async function runDeepseekCatalogProposal({
  baselinePath,
  outputDirectory,
  download = () => downloadDeepseekCatalog(globalThis.fetch),
}) {
  await mkdir(outputDirectory, { recursive: true });
  try {
    const baseline = parseBaseline(await readFile(baselinePath, "utf8"));
    const downloaded = await download();
    if (typeof downloaded.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(downloaded.sha256)) {
      throw new Error("DeepSeek 官方脚本 SHA-256 无效");
    }
    const candidate = normalizeDeepseekCatalog(downloaded.catalog);
    const difference = compareBaselines(baseline, candidate);
    const result = {
      status: "success",
      changed: difference.changed,
      source: deepseekSetupScriptUrl,
      sourceSha256: downloaded.sha256,
      ...difference,
    };
    await writeOutputs(outputDirectory, candidate, result, renderSummary(result));
    return result;
  } catch (error) {
    const message = safeErrorMessage(error);
    const result = {
      status: "failure",
      changed: false,
      source: deepseekSetupScriptUrl,
      sourceSha256: null,
      added: [],
      removed: [],
      modified: [],
      error: message,
    };
    await writeFile(
      resolve(outputDirectory, "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    await writeFile(
      resolve(outputDirectory, "summary.md"),
      `# DeepSeek 模型目录检查失败\n\n- 来源：${deepseekSetupScriptUrl}\n- 错误：${escapeMarkdown(message)}\n\n未创建候选基线或 Draft PR。\n`,
    );
    throw error;
  }
}

export function normalizeDeepseekCatalog(catalog) {
  if (!isRecord(catalog) || !Array.isArray(catalog.models)) {
    throw new Error("DeepSeek 官方模型目录缺少 models");
  }
  if (catalog.models.length === 0 || catalog.models.length > maximumModels) {
    throw new Error("DeepSeek 官方模型目录的模型数量无效");
  }
  const seen = new Set();
  const models = catalog.models.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("DeepSeek 官方模型条目无效");
    const slug = requiredString(candidate.slug, "模型 slug", 128);
    if (!slugPattern.test(slug)) throw new Error(`DeepSeek 模型 slug 无效：${slug}`);
    if (seen.has(slug)) throw new Error(`DeepSeek 模型 slug 重复：${slug}`);
    seen.add(slug);
    const supportedReasoningLevels = reasoningLevels(candidate, slug);
    const defaultReasoningLevel = requiredString(
      candidate.default_reasoning_level,
      `${slug} 默认思考等级`,
      64,
    );
    if (!supportedReasoningLevels.some(({ effort }) => effort === defaultReasoningLevel)) {
      throw new Error(`${slug} 默认思考等级不在支持列表中`);
    }
    return {
      slug,
      digest: createHash("sha256")
        .update(JSON.stringify(sortValue(candidate)))
        .digest("hex"),
      displayName: requiredString(candidate.display_name, `${slug} 显示名称`),
      description: requiredString(candidate.description, `${slug} 描述`),
      contextWindow: positiveInteger(candidate.context_window, `${slug} 上下文窗口`),
      maxContextWindow: positiveInteger(
        candidate.max_context_window,
        `${slug} 最大上下文窗口`,
      ),
      effectiveContextWindowPercent: positiveInteger(
        candidate.effective_context_window_percent,
        `${slug} 有效上下文比例`,
      ),
      inputModalities: stringArray(candidate.input_modalities, `${slug} 输入模态`),
      defaultReasoningLevel,
      supportedReasoningLevels,
      visibility: requiredString(candidate.visibility, `${slug} 可见性`, 64),
      minimalClientVersion: requiredString(
        candidate.minimal_client_version,
        `${slug} 最低客户端版本`,
        64,
      ),
      supportedInApi: requiredBoolean(candidate.supported_in_api, `${slug} API 支持状态`),
      supportsSearchTool: requiredBoolean(
        candidate.supports_search_tool,
        `${slug} 搜索支持状态`,
      ),
      supportsParallelToolCalls: requiredBoolean(
        candidate.supports_parallel_tool_calls,
        `${slug} 并行工具支持状态`,
      ),
      multiAgentVersion: requiredString(
        candidate.multi_agent_version,
        `${slug} 多代理版本`,
        64,
      ),
    };
  });
  models.sort((left, right) => left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0);
  return {
    schemaVersion: baselineSchemaVersion,
    source: deepseekSetupScriptUrl,
    models,
  };
}

export function compareBaselines(baseline, candidate) {
  const previous = new Map(baseline.models.map((model) => [model.slug, model]));
  const current = new Map(candidate.models.map((model) => [model.slug, model]));
  const added = candidate.models.filter(({ slug }) => !previous.has(slug)).map(({ slug }) => slug);
  const removed = baseline.models.filter(({ slug }) => !current.has(slug)).map(({ slug }) => slug);
  const modified = candidate.models
    .filter(({ slug, digest }) => previous.get(slug)?.digest !== digest && previous.has(slug))
    .map(({ slug }) => slug);
  return {
    changed: added.length > 0 || removed.length > 0 || modified.length > 0,
    added,
    removed,
    modified,
  };
}

function parseBaseline(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek 模型目录基线不是有效 JSON");
  }
  if (
    !isRecord(parsed)
    || parsed.schemaVersion !== baselineSchemaVersion
    || parsed.source !== deepseekSetupScriptUrl
    || !Array.isArray(parsed.models)
  ) {
    throw new Error("DeepSeek 模型目录基线格式无效");
  }
  if (parsed.models.length === 0 || parsed.models.length > maximumModels) {
    throw new Error("DeepSeek 模型目录基线的模型数量无效");
  }
  const seen = new Set();
  for (const model of parsed.models) {
    if (
      !isRecord(model)
      || typeof model.slug !== "string"
      || !slugPattern.test(model.slug)
      || typeof model.digest !== "string"
      || !/^[a-f0-9]{64}$/u.test(model.digest)
      || seen.has(model.slug)
    ) {
      throw new Error("DeepSeek 模型目录基线条目无效");
    }
    seen.add(model.slug);
  }
  return parsed;
}

async function writeOutputs(outputDirectory, candidate, result, summary) {
  await Promise.all([
    writeFile(
      resolve(outputDirectory, "candidate-baseline.json"),
      `${JSON.stringify(candidate, null, 2)}\n`,
    ),
    writeFile(
      resolve(outputDirectory, "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    ),
    writeFile(resolve(outputDirectory, "summary.md"), summary),
  ]);
}

function renderSummary(result) {
  return [
    "# DeepSeek 官方模型目录检查",
    "",
    `- 状态：${result.changed ? "发现变化" : "没有变化"}`,
    `- 来源：${result.source}`,
    `- 官方脚本 SHA-256：${result.sourceSha256}`,
    `- 新增模型：${formatList(result.added)}`,
    `- 移除模型：${formatList(result.removed)}`,
    `- 参数变化：${formatList(result.modified)}`,
    "",
    "候选基线记录完整模型指纹与有限审查字段，不复制上游提示词正文。",
    "即使发现新模型，本步骤也不会修改运行时受控模型列表、自动发布或部署。",
    "",
  ].join("\n");
}

function reasoningLevels(candidate, slug) {
  if (!Array.isArray(candidate.supported_reasoning_levels)
    || candidate.supported_reasoning_levels.length === 0) {
    throw new Error(`${slug} 缺少支持的思考等级`);
  }
  const efforts = new Set();
  return candidate.supported_reasoning_levels.map((level) => {
    if (!isRecord(level)) throw new Error(`${slug} 思考等级无效`);
    const effort = requiredString(level.effort, `${slug} 思考等级`, 64);
    if (efforts.has(effort)) throw new Error(`${slug} 思考等级重复：${effort}`);
    efforts.add(effort);
    return {
      effort,
      description: requiredString(level.description, `${slug} 思考等级描述`),
    };
  });
}

function requiredString(value, label, maximumLength = maximumTextLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`DeepSeek ${label}无效`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`DeepSeek ${label}无效`);
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`DeepSeek ${label}无效`);
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`DeepSeek ${label}无效`);
  }
  return value.map((entry) => requiredString(entry, label, 64));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatList(values) {
  return values.length === 0 ? "无" : values.map((value) => `\`${value}\``).join("、");
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : "未知错误";
  return message.slice(0, maximumTextLength);
}

function escapeMarkdown(value) {
  return value.replaceAll("`", "'").replaceAll("\n", " ");
}

async function main() {
  const [baselinePath, outputDirectory] = process.argv.slice(2);
  if (!baselinePath || !outputDirectory) {
    throw new Error(
      "用法：node scripts/prepare-deepseek-catalog-proposal.mjs <基线文件> <输出目录>",
    );
  }
  await runDeepseekCatalogProposal({ baselinePath, outputDirectory });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
