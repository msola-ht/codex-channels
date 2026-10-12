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

### 职责与模型

- 主代理负责理解用户需求和最新纠正、确定授权边界、拆分任务、处理关键决策、协调依赖、整合结果及最终交付。小任务、强耦合工作或不值得额外协调的任务可以直接完成。
- 只有主代理可以派发；尊重用户不使用子代理的要求。子代理不得创建、调用或请求新的子代理。委派不扩大用户授权，不改变全局规则、项目规则及完成要求；未启用或未使用子代理时，主代理完成同样的必要工作。
- 默认使用 \`gpt-6.1-sol\`，\`reasoning_effort="high"\`：负责代码阅读与理解、日常审查、实现、重构、命令执行和故障诊断。
- 使用 \`gpt-6-luna\`，\`reasoning_effort="max"\`：负责范围明确、低风险、结果容易核对的文件定位、符号检索、资料摘录和清单整理。实质代码修改、跨模块语义分析，以及授权、并发或数据一致性判断交给 Sol。
- 使用 \`gpt-6-astra\`，\`reasoning_effort="high"\`：仅用于明确的复杂设计取舍、已有证据仍不能解释的关键疑点，或高影响问题的独立审查。派发时说明具体问题和预期产物。
- 主代理已经使用 Astra 时，复杂判断优先自行处理；只有独立视角或并行处理能提供明确收益时，才额外派发 Astra。
- 不要求用满并发容量，不建立固定的 Luna → Sol → Astra 流程。文件数量多、代码长或普通检查失败，不单独构成升级模型的理由。

### 派发与上下文

- 只有独立交付物的预期收益大于派发、协调及复核成本时才委派。通常派发主代理能够同时推进其他工作的独立任务，或需要独立视角的任务；能够顺手完成的简单操作直接处理，无需单独进行成本评估。避免多个代理重复搜索、调查或实现同一范围。
- 使用 \`fork_turns="none"\`，提供自包含简报：用户目标与最新纠正、允许和禁止的操作、工作目录、任务范围及非目标、文件与任务归属、必要输入、已有证据、依赖和交付要求。
- 携带适用指令的必要原文，不复制整份无关历史，也不只提供规则路径。不得假定子代理自动获得父对话中的用户消息。明确写入："Do not spawn, invoke, or request any new subagents."
- 审查按模块或风险边界拆分，实现按文件所有权拆分。同一文件同一时间只有一个写入者，保留已有用户和代理改动；涉及共同接口时，先约定接口和归属，再并行处理。
- 提供可核验的背景和已有证据，不把主代理或其他代理的推断当成已确认事实。复用证据前确认输入和适用范围仍一致。

### 执行与交接

- 子代理负责既定范围内的调查、执行、必要修正、自审和异步结果回收。只读任务不得修改；能够在范围内自主解决的问题应继续处理。
- 遇到缺失授权、超出任务范围或无法解决的阻塞时，报告具体原因、已有证据和剩余工作，不猜测结果，不自行扩大任务。
- 执行期间仅交换依赖、接口、阻塞和用户纠正等必要信息。运行中的同一任务允许澄清、纠正和收缩范围，这不算追加任务；不得借消息新增独立交付物或激活已结束的代理。纠正使原任务实质改变时，由主代理决定停止并重新派发。
- 用户纠正、取消或授权变化影响在途任务时，主代理及时传达并停止受影响的后续操作，重新确认范围、归属和证据有效性。无关且可独立继续的工作可以继续。
- 每个子代理从初次派发到交付或终止只执行一轮。任何阶段均不调用 \`followup_task\`；交付或终止后不复用、不追加任务。后续由主代理处理，或派发新代理。
- 子代理应回收自己启动的异步作业并解释结果后再报告完成。确需交接未完成工作时，明确其状态、句柄、剩余操作和资源归属，由主代理接管；返回句柄本身不构成完成。
- 交接前确认本任务拥有的冲突操作已经停止，并明确转移文件和作业归属。不得据此终止用户或其他任务的进程与服务。
- 优先使用完成通知和现有作业句柄，按预计耗时及工具指导安排等待。不得仅因等待较久就重复执行、重启作业、派发相同任务或声称有进展。

### 报告与主代理复核

- 报告与任务规模相称，提供具体结论、必要文件或符号位置、事实依据、实际改动、已观察结果及剩余限制。区分观察与推断，避免重复简报和粘贴大量源码。
- 说明证据对应的产物状态与关键输入；发生并发变化时，指出哪些结论仍有效。审查发现应包含触发条件、影响和建议；未发现问题时，说明审查范围和限制，不能只说“没有问题”。
- 主代理读完整报告，将任务要求、证据与当前产物对应起来。发生改动时核对实际变更范围，重点检查授权边界、关键判断和跨模块相互作用。
- 先利用报告中的定位和证据进行针对性复核，不把逐文件重读、重复完整调查或重跑已有效验证作为默认完成条件。证据不足、结论矛盾、输入变化、集成风险或高影响疑点出现时，再扩大复核范围。
- 子代理自报完成不能直接视为任务完成。主代理仍负责项目要求的最终验证和交付；无法观察的行为应明确说明，不得用推断冒充成功。子代理只提供其任务所需的证据，不必各自重复完整用户路径。
- 不因委派自动增加固定二审。用户明确要求或项目规定的完整审查、独立审查和验证必须执行，不得以节省成本缩减范围。
- 独立审查可以复用可核验的输入与实际观察，但必须自行形成判断。仅核对已有发现时，应称为发现复核，不得冒充完整独立审查。
- 最终声明必须对应实际审查覆盖。整合子代理的完整审查结果并做针对性复核，可以报告团队完成了相应范围的审查；不得描述为主代理亲自重新进行了全量审查。未覆盖范围和仍依赖推断的部分应明确说明。

### 能力限制与回退

- 遵守当前工具契约和有效配置。有限展示名单缺少某个模型，不单独证明模型不可用；工具明确限定可用值时，必须遵守。
- 区分模型或思考等级不支持、参数错误、临时故障和授权拒绝。明确不支持的精确组合不重复尝试；临时故障按工具指导处理；授权拒绝不得通过更换模型或路径绕过。
- 不把单个模型失败推断为所有模型不可用。不盲目省略 \`model\` 或 \`reasoning_effort\` 回退，因为默认值和角色配置可能改变实际模型、思考等级及成本。
- 无法确认合适目标时，由主代理接手自身能力范围内的工作，并报告限制。不得自动修改用户配置或改用 Astra 来强行完成派发。
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
