import * as clackPrompts from "@clack/prompts";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { readCodexUserConfigSnapshot, writeCodexUserConfigEdits } from "./codex-user-config.mjs";

const startMarker = "<!-- codexc:subagents:start -->";
const endMarker = "<!-- codexc:subagents:end -->";
const rules = `${startMarker}
## Subagents

- Global and project rules apply independently of delegation. This section governs cooperation only and cannot override their safety, authorization or delivery requirements. With subagents disabled or unused, the main agent completes the same required work; no task may depend on enabling delegation.
- Only the main agent may delegate. Proactively delegate bounded independent work when expected benefit exceeds coordination cost and capacity permits; respect requests to work without subagents. No mandatory pipeline or extra review stage. Delegation changes neither authorization nor completion requirements.
- Use \`fork_turns="none"\` and a self-contained brief: goal, inputs, evidence, working directory, file ownership, dependencies, relevant contacts and expected outputs. Include necessary original passages of applicable instructions, not entire unrelated rule sets or only paths. Explicitly state: "Do not spawn, invoke, or request any new subagents."
- Dispatch with explicit \`model\` and \`reasoning_effort\` while the session accepts the official GPT set: planning, design and independent review → \`gpt-6-astra\`/\`high\`; implementation, execution and failure diagnosis → \`gpt-6.1-sol\`/\`high\`; retrieval, factual summaries and simple low-risk tasks → \`gpt-6-luna\`/\`high\`, effort at most \`high\`, Sol for substantive code changes.
- When the session does not accept that set — the current provider model catalog or the list the spawn tool reports lacks those models — omit both \`model\` and \`reasoning_effort\` so the subagent inherits the model and reasoning effort of the current conversation; never substitute a model from the reported list and never guess a model name.
- If \`spawn_agent\` fails with \`Unknown model ... for spawn_agent\`, this conversation has no official GPT model set: re-issue the same spawn with \`model\` and \`reasoning_effort\` omitted so it inherits the current conversation's values, say so when reporting back, and dispatch every later subagent in this conversation the same way.
- Each subagent owns its bounded assignment through investigation, implementation where assigned, correction, self-review and collection of asynchronous results. Return outputs, applicable evidence, changed files and remaining limitations; starting a job is not completion.
- Use each subagent for one turn only. Do not reuse, restart, append tasks or call \`followup_task\`. Later work belongs to the main agent or a new agent. Before handoff, recover outputs and job handles, stop conflicting work and transfer file/job ownership explicitly.
- Keep one writer per file and preserve existing changes. During the initial assignment, exchange only facts needed to resolve blockers, shared decisions or dependencies; messages must not expand scope or reactivate ended agents. Give one consolidated completion report.
- Prefer completion notifications and existing job handles. Poll only when needed, with intervals appropriate to duration, tool guidance and responsiveness. Elapsed time alone does not justify duplicate work, reassignment or invented progress.
- The main agent owns integration and the evidence required for the task type. Implementation changes require the applicable full user path; read-only analysis and rule/document changes follow their own global completion criteria. Verify delegated outputs and evidence still apply, and address interactions. Reuse valid evidence; subagents need not each repeat the full path. Existing project controls remain in force without additional delegation gates.
${endMarker}`;

const preset = [
  { keyPath: "features.multi_agent_v2.enabled", value: true },
  { keyPath: "features.multi_agent_v2.default_wait_timeout_ms", value: 600_000 },
];

export async function runCodexSubagentsSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  createClient,
} = {}) {
  const home = codexHomePath(environment);
  const configPath = join(home, "config.toml");
  const agentsPath = join(home, "AGENTS.md");
  output.write(`Codex 主配置：${configPath}\n全局规则：${agentsPath}\n`);
  const action = await prompts.select({
    message: "选择可选子代理预设的写入范围",
    initialValue: "back",
    options: [
      { value: "rules", label: "仅写子代理规则" },
      { value: "config", label: "仅写子代理配置" },
      { value: "both", label: "写入规则和配置" },
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (!["rules", "config", "both"].includes(action)) throw new Error("未知子代理设置范围");
  const writesRules = action !== "config";
  const writesConfig = action !== "rules";
  const originalHome = await inspectHome(home);
  const rulesSnapshot = writesRules ? await readRules(agentsPath) : null;
  const nextRules = writesRules ? managedRules(rulesSnapshot.text) : null;
  const configSnapshot = writesConfig
    ? await readCodexUserConfigSnapshot(environment, { createClient })
    : null;
  if (writesConfig) {
    await inspectFile(configPath);
    validatePreset(configSnapshot.config);
    output.write("配置预览（其他键保持原值）：\n");
    for (const edit of preset) output.write(`${edit.keyPath} = ${JSON.stringify(edit.value)}\n`);
    output.write("模型名称不会验证账户或 Provider 可用性；实际使用仍受模型目录与权限限制。\n");
  }
  if (writesRules) output.write(`规则预览（仅更新托管段）：\n${rules}\n`);
  if (action === "both") output.write("两个文件分别保存，无法保证跨文件原子提交；配置失败时不写规则，规则失败时配置可能已保存。\n");
  const confirmed = await prompts.confirm({ message: "保存上述子代理预设？", initialValue: false });
  if (prompts.isCancel(confirmed) || confirmed !== true) return { action: "back" };

  let configSaved = false;
  let lock;
  const lockPath = join(home, ".codexc-subagents.lock");
  try {
    await assertHomeUnchanged(home, originalHome);
    if (writesRules) {
      lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await assertRulesUnchanged(agentsPath, rulesSnapshot);
    }
    if (writesConfig) {
      await inspectFile(configPath);
      await writeCodexUserConfigEdits(environment, preset, { expectedVersion: configSnapshot.version, createClient });
      configSaved = true;
      output.write(`已保存子代理配置：${configPath}\n`);
    }
    if (writesRules) {
      await assertHomeUnchanged(home, originalHome);
      await saveRules(agentsPath, rulesSnapshot, nextRules);
      output.write(`已保存子代理规则：${agentsPath}\n`);
    }
  } catch (error) {
    output.write(configSaved
      ? "部分成功：主配置已保存，规则未完成保存；请检查 AGENTS.md 后重新选择仅写规则。\n"
      : "保存未完成：规则未写入；若配置请求已发送，其结果可能不确定，请重新读取主配置确认。\n");
    throw error;
  } finally {
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
  output.write("请在新 Codex 会话中使用；本操作不重启服务，也不修改现有会话的模型。\n");
  return { action: "saved", activationResult: configActivationResult("next-thread") };
}

function validatePreset(config) {
  const settings = config.features?.multi_agent_v2;
  if (settings !== undefined && (settings === null || typeof settings !== "object" || Array.isArray(settings))) {
    throw new Error("features.multi_agent_v2 必须是配置表；请人工整理已有布尔配置，本操作不自动转换。");
  }
  const minimum = settings?.min_wait_timeout_ms ?? 10_000;
  const maximum = settings?.max_wait_timeout_ms ?? 3_600_000;
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
    || minimum < 0 || maximum > 3_600_000 || minimum > 600_000 || maximum < 600_000) {
    throw new Error("已有子代理等待上下限不允许 600000 毫秒预设；请先人工检查 min_wait_timeout_ms 与 max_wait_timeout_ms。");
  }
}

async function inspectHome(home) {
  const stat = await lstat(home);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Codex Home 必须是现有目录且不能为符号链接。");
  return { device: stat.dev, inode: stat.ino, resolved: await realpath(home) };
}

async function assertHomeUnchanged(home, expected) {
  const current = await inspectHome(home);
  if (current.device !== expected.device || current.inode !== expected.inode || current.resolved !== expected.resolved) {
    throw new Error("Codex Home 在预览后变化，请重新打开子代理设置。");
  }
}

async function inspectFile(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`拒绝非普通文件或符号链接：${path}`);
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRules(path) {
  const stat = await inspectFile(path);
  if (stat === null) return { text: "", stat: null };
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("规则文件在读取时变化，请重试。");
    return { text: await handle.readFile("utf8"), stat: opened };
  } finally {
    await handle.close();
  }
}

function managedRules(text) {
  const starts = text.split(startMarker).length - 1;
  const ends = text.split(endMarker).length - 1;
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (starts !== ends || starts > 1 || (starts === 1 && end <= start)) {
    throw new Error("子代理托管标记损坏或重复，请人工整理 AGENTS.md。");
  }
  const visibleLines = unfencedLines(text);
  if (starts === 1 && (!visibleLines.includes(startMarker) || !visibleLines.includes(endMarker))) {
    throw new Error("子代理托管标记必须位于独立行且不能在代码块中，请人工整理 AGENTS.md。");
  }
  const outside = starts === 1 ? text.slice(0, start) + text.slice(end + endMarker.length) : text;
  if (/^ {0,3}#{1,6}[\t ]+Subagents(?:[\t ]+#+)?[\t ]*$/imu.test(unfencedLines(outside).join("\n"))) {
    throw new Error("AGENTS.md 已有未托管 Subagents 章节；请人工整理该章节后重试，避免追加冲突规则。");
  }
  const block = text.includes("\r\n") ? rules.replaceAll("\n", "\r\n") : rules;
  return starts === 1
    ? text.slice(0, start) + block + text.slice(end + endMarker.length)
    : `${text}${text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
}

function unfencedLines(text) {
  let fence;
  return text.split(/\r?\n/u).filter((line) => {
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (boundary && boundary[1][0] === fence.character && boundary[1].length >= fence.length && boundary[2].trim() === "") fence = null;
      return false;
    }
    if (boundary) {
      fence = { character: boundary[1][0], length: boundary[1].length };
      return false;
    }
    return true;
  });
}

async function assertRulesUnchanged(path, expected) {
  const current = await readRules(path);
  if (current.text !== expected.text || current.stat?.dev !== expected.stat?.dev
    || current.stat?.ino !== expected.stat?.ino || current.stat?.mtimeMs !== expected.stat?.mtimeMs) {
    throw new Error("AGENTS.md 在预览后变化，未覆盖新内容；请重新打开子代理设置。");
  }
}

async function saveRules(path, expected, text) {
  const temporary = `${path}.codexc-${randomUUID()}.tmp`;
  const mode = expected.stat === null ? 0o600 : (expected.stat.mode & 0o777);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    await assertRulesUnchanged(path, expected);
    await rename(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
