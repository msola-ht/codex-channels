import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { securePrivateDirectorySync } from "../runtime/private-file.mjs";
import { packageDir } from "./package-path.mjs";

export function projectSkillsRoot(projectRoot = packageDir) {
  return join(projectRoot, ".codex", "skills");
}

export function agentsSkillsDirectory(environment = process.env) {
  const override = environment.CODEX_AGENTS_SKILLS_DIR?.trim();
  return override || join(homedir(), ".agents", "skills");
}

export function listProjectSkills({
  projectRoot = packageDir,
  environment = process.env,
} = {}) {
  const root = projectSkillsRoot(projectRoot);
  if (!existsSync(root)) return [];
  const installed = new Set(listInstalledSkills({ environment }));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
      && !entry.name.startsWith(".")
      && existsSync(join(root, entry.name, "SKILL.md"))
    )
    .map((entry) => ({
      name: entry.name,
      path: join(root, entry.name),
      installed: installed.has(entry.name),
    }));
}

export function listInstalledSkills({ environment = process.env } = {}) {
  const root = agentsSkillsDirectory(environment);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
      && !entry.name.startsWith(".")
      && existsSync(join(root, entry.name, "SKILL.md"))
    )
    .map((entry) => entry.name);
}

export function installSkill({
  name,
  projectRoot = packageDir,
  environment = process.env,
  overwrite = false,
  expectedTargetRevision,
} = {}) {
  validateSkillName(name);
  const source = join(projectSkillsRoot(projectRoot), name);
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new Error(`项目技能不存在：${name}`);
  }
  const targetRoot = resolve(agentsSkillsDirectory(environment));
  const target = join(targetRoot, name);
  const initialState = readSkillTargetState(target);
  if (expectedTargetRevision !== undefined && initialState.revision !== expectedTargetRevision) {
    throw new Error(`技能目标已在确认期间变化，请重新选择并确认：${target}`);
  }
  if (initialState.tree !== null) {
    if (!overwrite) {
      return { name, installed: false, target, reason: "exists" };
    }
  }
  mkdirSync(targetRoot, { recursive: true });
  const preparedState = readSkillTargetState(target);
  if (initialState.tree !== preparedState.tree
    || (initialState.parent !== null && initialState.parent !== preparedState.parent)) {
    throw new Error(`技能目标已变化，请重新选择并确认：${target}`);
  }
  const transaction = mkdtempSync(join(targetRoot, `.${name}.install-`));
  const candidate = join(transaction, "candidate");
  const backup = join(transaction, "previous");
  let movedPrevious = false;
  let phase = "准备候选";
  try {
    const sourceRevision = readSkillTree(source);
    cpSync(source, candidate, { recursive: true, errorOnExist: true, force: false });
    if (readSkillTree(source) !== sourceRevision) {
      throw new Error("复制期间项目技能已变化");
    }
    if (!existsSync(join(candidate, "SKILL.md"))) {
      throw new Error("候选 SKILL.md 不存在");
    }
    phase = "核对目标";
    if (readSkillTargetState(target).revision !== preparedState.revision) {
      throw new Error("技能目标在准备候选期间已变化");
    }
    if (initialState.tree !== null) {
      phase = "保留旧版";
      renameSync(target, backup);
      movedPrevious = true;
      // Rename can change the root ctime. Everything else, including descendants,
      // must still match the version that was confirmed.
      if (readSkillTree(backup) !== initialState.tree) {
        throw new Error("技能目标在保留旧版期间已变化");
      }
    }
    phase = "发布候选";
    const publishState = readSkillTargetState(target);
    if (publishState.parent !== preparedState.parent || publishState.tree !== null) {
      throw new Error("技能目标在发布前已变化");
    }
    renameSync(candidate, target);
  } catch (error) {
    let recovery = "原目标未被本次操作移走。";
    if (movedPrevious) {
      // Claim an absent destination exclusively. Never restore over a target that
      // another writer created, and retain the original tree even after recovery.
      try {
        if (readSkillTargetState(target).parent !== preparedState.parent) {
          throw new Error("技能目录已变化", { cause: error });
        }
        mkdirSync(target);
        cpSync(backup, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        recovery = `旧版已复制恢复到 ${target}；原目录仍保留在 ${backup}。`;
      } catch {
        recovery = `旧版自动恢复未完成，未覆盖已有文件；请核对目标 ${target}（可能含部分恢复文件），原目录保留在 ${backup}。`;
      }
    }
    const reason = typeof error?.code === "string" ? error.code : error.message;
    throw new Error(`技能安装失败（${phase}：${reason}）。${recovery}本次操作材料保留在 ${transaction}。`, { cause: error });
  }
  if (movedPrevious) {
    // An editor can still write through an old descriptor after the rename.
    // Keeping the old directory is the only safe way to retain such writes.
    return { name, installed: true, target, backup };
  }
  try {
    rmdirSync(transaction);
    return { name, installed: true, target };
  } catch {
    return { name, installed: true, target, retainedDirectory: transaction };
  }
}

function readSkillTargetState(target) {
  const parentState = readSkillDirectoryState(dirname(target));
  const parent = parentState?.identity ?? null;
  const tree = readSkillTree(target);
  return {
    parent,
    canonicalParent: parentState?.canonical ?? null,
    tree,
    revision: createHash("sha256").update(JSON.stringify([target, parent, tree])).digest("hex"),
  };
}

function readSkillDirectoryState(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;
  const canonical = realpathSync(path);
  const actual = statSync(canonical, { bigint: true });
  if (!actual.isDirectory()) throw new Error(`技能父路径不是目录：${path}`);
  return { canonical, identity: JSON.stringify([canonical, String(actual.dev), String(actual.ino)]) };
}

function readSkillTree(root) {
  if (!lstatSync(root, { throwIfNoEntry: false })) return null;
  const hash = createHash("sha256");
  function visit(path, relative) {
    const stat = lstatSync(path, { bigint: true });
    const metadata = (value) => JSON.stringify([
      String(value.dev), String(value.ino), String(value.mode), String(value.uid), String(value.gid),
      String(value.size), String(value.mtimeNs), relative === "" ? null : String(value.ctimeNs),
    ]);
    const before = metadata(stat);
    hash.update(JSON.stringify([relative, before]));
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
    } else if (stat.isFile()) {
      hash.update(createHash("sha256").update(readFileSync(path)).digest());
    } else if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify(readlinkSync(path)));
      // Reject unresolvable links (for example loops or an overlong target)
      // before entering the native recursive copier. Dangling links remain valid.
      try {
        statSync(path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } else {
      throw new Error(`技能目录含不支持的文件类型：${path}`);
    }
    if (metadata(lstatSync(path, { bigint: true })) !== before) {
      throw new Error(`读取时技能目录已变化：${root}`);
    }
  }
  visit(root, "");
  return hash.digest("hex");
}

class SkillUninstallUnconfirmedError extends Error {
  constructor(message, { cause, target, retainedDirectory }) {
    super(message, { cause });
    this.name = "SkillUninstallUnconfirmedError";
    this.target = target;
    this.retainedDirectory = retainedDirectory;
  }
}

export function uninstallSkill({ name, environment = process.env, expectedTargetRevision } = {}) {
  validateSkillName(name);
  const target = join(resolve(agentsSkillsDirectory(environment)), name);
  const initialState = readSkillTargetState(target);
  if (expectedTargetRevision !== undefined && initialState.revision !== expectedTargetRevision) {
    throw new Error(`技能目标已在确认期间变化，请重新选择并确认：${target}`);
  }
  if (initialState.tree === null) {
    return { name, removed: false, target };
  }
  // Hidden directories inside a skills root can still be discovered upstream.
  // Retain the actual tree outside that root, on the same filesystem if possible.
  const retentionParent = dirname(initialState.canonicalParent);
  if (retentionParent === initialState.canonicalParent) {
    throw new Error(`无法在技能发现目录之外保留原目录，未卸载：${target}`);
  }
  const retentionParentState = readSkillDirectoryState(retentionParent);
  let transaction;
  let retainedDirectory;
  let moveAttempted = false;
  let movedPrevious = false;
  let phase = "准备保留目录";
  try {
    transaction = mkdtempSync(join(retentionParent, ".codexc-skill-uninstall-"));
    securePrivateDirectorySync(transaction);
    const transactionState = readSkillDirectoryState(transaction);
    retainedDirectory = join(transaction, "previous");
    const assertRetentionLocation = () => {
      if (readSkillDirectoryState(retentionParent)?.identity !== retentionParentState.identity
        || readSkillDirectoryState(transaction)?.identity !== transactionState.identity
        || dirname(transactionState.canonical) !== retentionParent) {
        throw new Error("技能保留目录或其父目录已变化");
      }
    };
    phase = "核对确认目标";
    assertRetentionLocation();
    if (readSkillTargetState(target).revision !== initialState.revision) {
      throw new Error("技能目标在准备卸载期间已变化");
    }
    phase = "保留原目录";
    // No copy-and-delete fallback: EXDEV or a sharing violation leaves the tree
    // installed. Never delete this tree; old descriptors can still write to it.
    moveAttempted = true;
    renameSync(target, retainedDirectory);
    movedPrevious = true;
    phase = "核对卸载结果";
    assertRetentionLocation();
    if (readSkillTree(retainedDirectory) !== initialState.tree) {
      throw new Error("技能原目录在移走期间已变化");
    }
    const finalState = readSkillTargetState(target);
    if (finalState.parent !== initialState.parent || finalState.tree !== null) {
      throw new Error("技能目标或父目录在移走后已变化");
    }
  } catch (error) {
    const reason = typeof error?.code === "string" ? error.code : error.message;
    const retained = movedPrevious
      ? `原目录已移至 ${retainedDirectory}（路径和内容须人工核对）；不会自动恢复或覆盖目标 ${target}。`
      : moveAttempted
        ? `移动结果未确认，请核对目标 ${target} 与保留位置 ${retainedDirectory}；不会重试移动或覆盖目标。`
        : `原目标未被本次操作移走：${target}。`;
    const message = `技能卸载未确认（${phase}：${reason}）。${retained}${transaction ? `操作材料保留在 ${transaction}。` : ""}`;
    if (moveAttempted) {
      throw new SkillUninstallUnconfirmedError(message, { cause: error, target, retainedDirectory });
    }
    throw new Error(message, { cause: error });
  }
  return { name, removed: true, target, retainedDirectory };
}

export async function runSkillSetup({
  output = process.stdout,
  prompts = clackPrompts,
  projectRoot = packageDir,
  environment = process.env,
} = {}) {
  while (true) {
    const action = await prompts.select({
      message: "选择技能操作",
      showInstructions: false,
      options: [
        {
          value: "install",
          label: "安装或更新",
          hint: "从项目 .codex/skills 安装到 ~/.agents/skills",
        },
        {
          value: "uninstall",
          label: "卸载",
          hint: "移出安装位置，保留原目录",
        },
        { value: "back", label: "返回", hint: "返回设置类别" },
      ],
    });
    if (prompts.isCancel(action) || action === "back") {
      return { action: "back" };
    }
    if (action === "install") {
      const skills = listProjectSkills({ projectRoot, environment });
      if (skills.length === 0) {
        output.write("项目 .codex/skills 下没有可安装技能。\n");
        continue;
      }
      const skill = await prompts.select({
        message: "选择要安装的技能",
        showInstructions: false,
        options: [
          ...skills.map((entry) => ({
            value: entry.name,
            label: entry.name,
            hint: entry.installed ? "已安装，选择后确认覆盖" : "未安装",
          })),
          { value: "back", label: "返回", hint: "返回技能操作" },
        ],
      });
      if (prompts.isCancel(skill) || skill === "back") continue;
      let overwrite = false;
      validateSkillName(skill);
      const target = join(resolve(agentsSkillsDirectory(environment)), skill);
      const targetState = readSkillTargetState(target);
      if (targetState.tree !== null) {
        const confirmed = await prompts.confirm({
          message: `${skill} 已安装，覆盖更新？`,
          initialValue: true,
        });
        if (prompts.isCancel(confirmed) || !confirmed) continue;
        overwrite = true;
      }
      const result = installSkill({
        name: skill,
        projectRoot,
        environment,
        overwrite,
        expectedTargetRevision: targetState.revision,
      });
      output.write(result.installed
        ? `已安装技能 ${result.name}：${result.target}\n${result.backup ? `旧版保留在 ${result.backup}；核对后可手动清理。\n` : ""}${result.retainedDirectory ? `操作目录保留在 ${result.retainedDirectory}，请核对后手动清理。\n` : ""}下个会话生效。\n`
        : `未安装（${result.reason}）：${result.name}\n`);
      continue;
    }
    if (action === "uninstall") {
      const installed = listInstalledSkills({ environment });
      if (installed.length === 0) {
        output.write("~/.agents/skills 下没有已安装技能。\n");
        continue;
      }
      const skill = await prompts.select({
        message: "选择要卸载的技能",
        showInstructions: false,
        options: [
          ...installed.map((name) => ({ value: name, label: name })),
          { value: "back", label: "返回", hint: "返回技能操作" },
        ],
      });
      if (prompts.isCancel(skill) || skill === "back") continue;
      validateSkillName(skill);
      const target = join(resolve(agentsSkillsDirectory(environment)), skill);
      const targetState = readSkillTargetState(target);
      const confirmed = await prompts.confirm({
        message: `确认卸载技能 ${skill}（${target}）并保留原目录？`,
        initialValue: false,
      });
      if (prompts.isCancel(confirmed) || !confirmed) continue;
      let result;
      try {
        result = uninstallSkill({ name: skill, environment, expectedTargetRevision: targetState.revision });
      } catch (error) {
        if (error instanceof SkillUninstallUnconfirmedError) {
          // Setup sanitizes and shortens error summaries. Keep controlled recovery
          // paths complete here without exposing arbitrary underlying exceptions.
          output.write(`技能卸载未确认。\n记录的原目录保留位置：${error.retainedDirectory}\n安装目标：${error.target}\n请人工核对路径与内容；不会自动恢复或覆盖目标。恢复前请停止相关写入者，并核对安装目标不存在。\n`);
        }
        throw error;
      }
      output.write(result.removed
        ? `已卸载技能 ${result.name}：${result.target}\n原目录保留在 ${result.retainedDirectory}。\n恢复前请停止相关写入者，并核对安装目标不存在；内容核对完成且无进程继续使用后，可手动清理。\n`
        : `技能不存在：${result.name}\n`);
      continue;
    }
    throw new Error(`未知技能操作：${String(action)}`);
  }
}

function validateSkillName(name) {
  if (
    typeof name !== "string"
    || name.length === 0
    || name === "."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("..")
  ) {
    throw new Error(`无效技能名称：${String(name)}`);
  }
}
