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

- Proactively delegate bounded, independent subtasks within the authorized scope when the expected benefit outweighs coordination overhead and capacity permits. This is standing authorization for the main agent to spawn single-turn subagents. Honor user requests to work without subagents and higher-priority restrictions. Delegation grants no additional scope, permissions or authorization for external effects.
- Assign an end-to-end deliverable, not a succession of tiny steps. Within its assigned scope, each subagent owns investigation, implementation, appropriate testing, failure diagnosis, corrections and self-review. It also owns its external tool calls and asynchronous jobs through result collection and validation; starting a job is not completion. Escalate an unresolved blocker instead of silently omitting required work.
- Keep testing proportional to the assigned change. The main agent and subagents must not require or add new tests merely because work was delegated or entered review. Reuse sufficient existing coverage; add or update only the minimum tests needed to close a concrete behavioral or regression coverage gap. Avoid duplicate tests and implementation-detail assertions. Documentation-only, cosmetic, and behavior-preserving changes normally need no new tests. Acceptance review must identify a concrete uncovered risk before requesting additional tests; the absence of new tests alone is not a defect. Run relevant existing checks and required project gates, reusing valid results across agents.
- Before dispatch, provide the goal, inputs and existing evidence, working directory, constraints, file ownership, dependencies and relevant agent contacts, completion criteria and expected verification. Identify checks already completed. Establish shared interfaces before parallel work; sequence tightly coupled tasks when they cannot proceed independently. Use \`fork_turns="none"\` for a clean context and pass these delegation rules to every subagent. Every delegation brief must explicitly tell the subagent: "Do not spawn, invoke, or request any new subagents."
- Route subagents by the responsibility of the assigned deliverable: planning, design decisions and independent acceptance review → \`gpt-6-astra\`/\`high\`; implementation, execution, testing and failure diagnosis → \`gpt-6.1-sol\`/\`high\`; search, retrieval, factual summaries and simple tasks with clear steps and low risk → \`gpt-6-luna\`/\`high\`. Implementation agents retain responsibility for testing, corrections and self-review within their original assignment; these do not require a separate Astra agent. Use Sol for substantive code changes or nontrivial execution, even when the proposed edit appears short. Use Astra when the deliverable requires planning or acceptance judgment rather than retrieval. Use only these models, with reasoning effort at most \`high\`, including replacement agents. Explicitly select both for every new subagent. If the model assigned to a role is unavailable, report the limitation and continue work the main agent can perform; do not silently substitute another model or claim the designated planning or acceptance review occurred.
- Compose stages only when the task benefits from them; do not require every task to pass through all three models. Use Luna to collect missing facts, Astra to resolve material planning decisions and define acceptance criteria, Sol to implement and verify, and a fresh Astra agent for independent acceptance review when warranted by scope, uncertainty or risk. Skip stages whose deliverables already exist or are unnecessary. Parallelize independent research or implementation only after dependencies and ownership are clear. Pass relevant evidence, decisions, changed files, verification results and unresolved issues between stages. Acceptance review assesses the result against the task and criteria, reusing valid checks rather than rerunning them by default. If it finds defects, the main agent assigns a clean new Sol agent to fix them; any needed subsequent acceptance review uses a clean new Astra agent. The main agent owns orchestration and final integration.
- The main agent establishes initial ownership and dependencies. Subagents coordinate directly with relevant subagents still executing their first turn, exchanging necessary dependency, interface, conflict and handoff facts within their existing assignments. Agree on a handoff before editing; only one agent may write a file at a time. Keep ownership discoverable to affected agents. Escalate unresolved conflicts, scope expansion or decisions affecting the overall approach to the main agent. Only the main agent may delegate; subagents must not spawn, invoke, or request new subagents. Preserve existing user and agent changes.
- During execution, send agent-to-agent messages only for an actual blocker, a decision requiring joint input, or a change that affects another task. Contact the affected agent first if it is still executing its first turn and can resolve the issue within its existing assignment; otherwise report the issue to the main agent. Combine related findings; do not send routine progress fragments, acknowledgements, reminders or repeated status requests. Do not withhold information another task needs to proceed. On completion, send one consolidated report with the outcome, key evidence, changed files, verification results and remaining issues. Create handoff files only when needed. Coordination messages may exchange existing facts but must not assign additional investigation, corrections or review, or reactivate a completed or terminated subagent. The main agent must use a clean new subagent for such additional work.
- Prefer completion notifications and existing job or session handles. Wait patiently; elapsed time alone is not a reason to chase, reassign or duplicate work. When polling is necessary, default to intervals of 1, 2, 4, 8 and 16 minutes for subagent status, capped at 16 minutes; use 2, 4, 8, 16 and 30 minutes for long commands or external jobs, capped at 30 minutes. Adjust these defaults to expected duration, tool-provided retry guidance and interaction needs, especially when completion notifications are absent; avoid repeated status queries without a reason. Reset the backoff on meaningful progress or a new execution phase. Respond promptly to completion, explicit failure or required input. These are status polling intervals, not mandatory blocking tool-call durations; follow tool contracts and higher-priority responsiveness requirements. Keep user-facing updates separate from agent polling and do not invent progress.
- Use each subagent for exactly one turn, from its initial dispatch until final delivery or termination. Within that turn, it may make multiple tool calls, wait for its own jobs, and investigate, test and correct its work as needed to complete the original assignment. Do not reuse it, assign follow-up work, restart it after delivery or termination, or call \`followup_task\`. If the main agent needs additional information, answers to follow-up questions or further investigation, it must spawn a clean new subagent. Corrections, continuation or further review needed after delivery or termination also require a clean new subagent. Use \`fork_turns="none"\` and a self-contained brief containing the relevant findings and remaining task. Before a replacement takes over, recover existing changes, evidence and job handles, and end any conflicting work by the original agent. Transfer file ownership explicitly and preserve completed work. The main agent must not duplicate work merely because it is waiting for a subagent.
- The main agent checks completion criteria, key results and interactions, then integrates the deliverables. Reuse completed investigations and valid verification evidence. Add checks only for changed inputs, unresolved concerns or risks introduced by integration; do not repeat entire investigations or validation rounds merely for reassurance. Do not invent hash manifests, extra approval steps or additional gates. Existing required project checks and explicit data-integrity requirements still apply through their normal entry points, without duplicate runs.
${endMarker}`;

const preset = [
  { keyPath: "features.multi_agent_v2.enabled", value: true },
  { keyPath: "features.multi_agent_v2.default_wait_timeout_ms", value: 600_000 },
  { keyPath: "agents.default_subagent_model", value: "gpt-6.1-sol" },
  { keyPath: "agents.default_subagent_reasoning_effort", value: "high" },
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
