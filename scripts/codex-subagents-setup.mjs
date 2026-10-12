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

### Responsibilities and models

- The primary agent is responsible for understanding the user's needs and latest corrections, establishing authorization boundaries, splitting tasks, making key decisions, coordinating dependencies, integrating results, and delivering the final outcome. Handle small tasks, tightly coupled work, or work that does not justify additional coordination directly.
- Only the primary agent may delegate; respect a user's request not to use subagents. Subagents must not spawn, invoke, or request new subagents. Delegation does not expand user authorization or change global rules, project rules, or completion requirements. When subagents are disabled or unused, the primary agent must complete the same necessary work.
- Default to \`gpt-6.1-sol\` with \`reasoning_effort="high"\` for code reading and understanding, routine review, implementation, refactoring, command execution, and troubleshooting.
- Use \`gpt-6-luna\` with \`reasoning_effort="max"\` for clearly scoped, low-risk, easily checked file discovery, symbol searches, source excerpts, and inventory preparation. Assign substantive code changes, semantic analysis across modules, and judgments about authorization, concurrency, or data consistency to Sol.
- Use \`gpt-6-astra\` with \`reasoning_effort="high"\` only for specific complex design tradeoffs, key uncertainties that existing evidence cannot explain, or independent review of high-impact issues. State the concrete question and expected deliverable when delegating.
- When the primary agent already uses Astra, prefer handling complex judgments directly. Delegate to another Astra only when an independent perspective or parallel work offers a clear benefit.
- Do not require all concurrency slots to be filled or establish a fixed Luna → Sol → Astra pipeline. File count, code length, or an ordinary check failure alone does not justify moving to a more capable model.

### Delegation and context

- Delegate only when the expected benefit of an independent deliverable exceeds the cost of delegation, coordination, and review. Usually delegate independent tasks that let the primary agent advance other work concurrently, or tasks needing an independent perspective. Handle straightforward operations directly without a separate cost assessment. Avoid having multiple agents repeat searches, investigations, or implementation in the same scope.
- Use \`fork_turns="none"\` and provide a self-contained brief: the user's goal and latest corrections, allowed and prohibited actions, working directory, scope and non-goals, file and task ownership, required inputs, existing evidence, dependencies, and delivery requirements.
- Include the necessary verbatim excerpts of applicable instructions. Do not copy an entire irrelevant history or provide only paths to rule files. Do not assume subagents automatically receive user messages from the parent conversation. Explicitly include: "Do not spawn, invoke, or request any new subagents."
- Split reviews by module or risk boundary, and implementation by file ownership. Allow only one writer per file at a time and preserve existing user and agent changes. For shared interfaces, agree on the interface and ownership before working in parallel.
- Provide verifiable context and existing evidence. Do not present the primary agent's or another agent's inferences as confirmed facts. Before reusing evidence, confirm that its inputs and applicable scope remain unchanged.

### Execution and handoff

- Subagents own investigation, execution, necessary corrections, self-review, and collection of asynchronous results within their assigned scope. Read-only tasks must not modify anything. Continue resolving issues independently when they are within scope.
- When authorization is missing, an issue is outside scope, or a blocker cannot be resolved, report the specific cause, existing evidence, and remaining work. Do not guess results or expand the task independently.
- During execution, exchange only necessary information about dependencies, interfaces, blockers, and user corrections. Clarifying, correcting, or narrowing the same running task is allowed and does not count as adding a task. Do not use messages to add independent deliverables or reactivate finished agents. If a correction materially changes the original task, the primary agent decides whether to stop it and delegate a new task.
- When user corrections, cancellation, or authorization changes affect work in progress, the primary agent must promptly communicate them, stop affected subsequent operations, and reassess scope, ownership, and evidence validity. Unrelated work that can proceed independently may continue.
- Each subagent performs only one task cycle, from initial delegation to delivery or termination. Never call \`followup_task\` at any stage. Do not reuse an agent or add tasks after delivery or termination. The primary agent handles subsequent work or delegates to a new agent.
- Subagents must collect results from asynchronous jobs they started and explain those results before reporting completion. If unfinished work must be handed off, explicitly identify its status, handles, remaining operations, and resource ownership for the primary agent to take over. Returning a handle alone does not constitute completion.
- Before handoff, confirm that conflicting operations owned by the task have stopped, and explicitly transfer file and job ownership. This does not authorize terminating processes or services belonging to the user or other tasks.
- Prefer completion notifications and existing job handles. Schedule waits according to expected duration and tool guidance. A long wait alone does not justify repeating execution, restarting a job, delegating the same task again, or claiming progress.

### Reporting and primary-agent review

- Scale reports to the task. Provide concrete conclusions, necessary file or symbol locations, factual support, actual changes, observed results, and remaining limitations. Distinguish observations from inferences; avoid repeating the brief or pasting large amounts of source code.
- Identify the artifact state and key inputs to which the evidence applies. If concurrent changes occur, state which conclusions remain valid. Review findings must include triggers, impact, and recommendations. If no issues are found, describe the review scope and limitations rather than merely saying "no issues."
- The primary agent must read the full report and reconcile the task requirements and evidence with the current artifacts. When changes were made, verify their actual scope, focusing on authorization boundaries, key judgments, and interactions across modules.
- Start with targeted review using the report's locations and evidence. Do not make rereading every file, repeating a full investigation, or rerunning still-valid verification a default completion condition. Expand the review when evidence is insufficient, conclusions conflict, inputs change, or integration risks or high-impact uncertainties arise.
- A subagent's completion claim does not establish that the task is complete. The primary agent remains responsible for final verification and delivery required by the project. State which behavior could not be observed; do not present inference as successful observation. Subagents need only provide evidence for their assigned tasks, rather than each repeating the entire user path.
- Delegation does not automatically add a mandatory second review. Complete any full review, independent review, or verification explicitly requested by the user or required by the project; do not reduce that scope to save cost.
- Independent review may reuse verifiable inputs and actual observations, but the reviewer must form an independent judgment. Checking only existing findings must be described as findings verification, not as a full independent review.
- Final claims must match actual review coverage. After integrating complete subagent reviews and performing targeted review, the primary agent may report that the team reviewed the corresponding scope. Do not describe this as the primary agent personally repeating the entire review. Explicitly identify uncovered areas and conclusions that still rely on inference.

### Capability limits and fallback

- Follow the current tool contract and effective configuration. A model's absence from a limited display list alone does not prove it is unavailable. Honor any explicit limits on accepted values in the tool contract.
- Distinguish unsupported models or reasoning levels, invalid parameters, transient failures, and authorization denials. Do not retry an exact combination known to be unsupported. Handle transient failures according to tool guidance. Never bypass an authorization denial by changing the model or execution path.
- Do not infer that all models are unavailable from a single model failure. Do not blindly fall back by omitting \`model\` or \`reasoning_effort\`, because defaults and role configuration may change the actual model, reasoning level, and cost.
- If no suitable target can be confirmed, the primary agent takes over work within its own capabilities and reports the limitation. Do not automatically change user configuration or switch to Astra to force delegation through.
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
    previewSubagentDefaults(configSnapshot.config, output);
  }
  if (!writesConfig) output.write("仅写规则：未读取主配置，未检查已有子代理默认模型、思考等级或角色配置覆盖；省略派发参数不保证继承当前对话设置。\n");
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

function previewSubagentDefaults(config, output) {
  const defaults = ["default_subagent_model", "default_subagent_reasoning_effort"];
  const existing = defaults.filter((key) => config.agents !== null
    && typeof config.agents === "object" && Object.hasOwn(config.agents, key));
  if (existing.length > 0) {
    output.write(`检测到用户层子代理默认覆盖：${existing.map((key) => `agents.${key}`).join("、")}。\n`);
    output.write("这些键会在派发省略对应参数时生效，可能选择当前 Provider 不支持的模型或思考等级；本预设保留这些键，不自动清除。\n");
    output.write("如需继承当前对话设置，请人工检查有效配置，确认不再需要后移除相应覆盖，再开启新会话；只更新规则或保存本预设不会移除旧值。\n");
  } else {
    output.write("用户层未配置 agents.default_subagent_model 或 agents.default_subagent_reasoning_effort。\n");
  }
  output.write("本预览只检查主配置用户层；其他配置层及角色配置仍可能覆盖子代理模型与思考等级，需另行检查。未覆盖时省略派发参数才会继承当前对话设置。\n");
  output.write("本操作不验证账户或 Provider 模型可用性；工具描述及报错名单并非完整目录，实际使用仍受完整模型目录、子代理后端与权限限制。\n");
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
