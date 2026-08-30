import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";

const trackedOptions = [
  "--config",
  "--remote",
  "--profile",
  "--sandbox",
  "--cd",
  "--ask-for-approval",
];
const contractPath = "src/codex-protocol/public-cli-contract.json";
export const supportedPublicApprovalPolicies = ["on-request", "never"];

export function parsePublicCliContract(versionOutput, helpOutput) {
  const versionMatch = /^codex-cli (\d+\.\d+\.\d+)$/u.exec(versionOutput.trim());
  if (!versionMatch) {
    throw new Error(`无法解析 Codex CLI 版本：${versionOutput.trim() || "(空输出)"}`);
  }
  const blocks = parseOptionBlocks(helpOutput);
  const options = {};
  for (const option of trackedOptions) {
    const block = blocks.get(option);
    options[option] = block
      ? {
          present: true,
          aliases: block.aliases,
          argument: block.argument,
          values: extractPossibleValues(block.lines),
        }
      : { present: false, aliases: [], argument: null, values: [] };
  }
  return {
    schemaVersion: 1,
    codexCli: versionMatch[1],
    options,
  };
}

export function capturePublicCliContract(codexBinary = "codex") {
  return parsePublicCliContract(
    runCodex(codexBinary, ["--version"]),
    runCodex(codexBinary, ["--help"]),
  );
}

export function writePublicCliContract(path, contract) {
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
}

export function comparePublicCliContracts(before, after) {
  assertContract(before);
  assertContract(after);
  const changes = [];
  const options = [...new Set([
    ...Object.keys(before.options),
    ...Object.keys(after.options),
  ])].sort();
  for (const option of options) {
    const previous = normalizeOption(before.options[option]);
    const current = normalizeOption(after.options[option]);
    if (previous.present !== current.present) {
      changes.push({
        option,
        kind: current.present ? "added" : "removed",
      });
      continue;
    }
    if (!current.present) continue;
    const previousSignature = renderOptionSignature(option, previous);
    const currentSignature = renderOptionSignature(option, current);
    if (previousSignature !== currentSignature) {
      changes.push({
        option,
        kind: "signature",
        before: previousSignature,
        after: currentSignature,
      });
    }
    const added = current.values.filter((value) => !previous.values.includes(value));
    const removed = previous.values.filter((value) => !current.values.includes(value));
    if (added.length || removed.length) {
      changes.push({ option, kind: "values", added, removed });
    }
  }
  return changes;
}

export function validateCodexUserSettingsAgainstContract(
  config,
  contract,
  configPath = "~/.codex/config.toml",
) {
  assertContract(contract);
  const accepted = normalizeOption(contract.options["--ask-for-approval"]).values;
  const document = record(config);
  validateApprovalPolicy(
    document.approval_policy,
    "approval_policy",
    accepted,
    contract.codexCli,
    configPath,
  );
  for (const [name, profile] of Object.entries(record(document.profiles))) {
    validateApprovalPolicy(
      record(profile).approval_policy,
      profileApprovalPolicyPath(name),
      accepted,
      contract.codexCli,
      configPath,
    );
  }
}

export function renderPublicCliContractImpact(before, after) {
  const changes = comparePublicCliContracts(before, after);
  const lines = [
    "# Codex 公开 CLI 合同影响",
    "",
    `基线：Codex CLI ${before.codexCli}；目标：Codex CLI ${after.codexCli}。`,
    "本报告只比较本项目实际转发的公开参数；App Server RPC 结构变化见 `protocol-impact.md`。",
    "",
  ];
  if (!changes.length) {
    lines.push("没有检测到受控公开 CLI 参数变化。", "");
    return lines.join("\n");
  }
  for (const change of changes) {
    if (change.kind === "added") {
      lines.push(`- **参数新增** \`${change.option}\``);
    } else if (change.kind === "removed") {
      lines.push(`- **参数删除** \`${change.option}\``);
    } else if (change.kind === "signature") {
      lines.push(
        `- **参数签名变化** \`${change.option}\`：\`${change.before}\` → \`${change.after}\``,
      );
    } else {
      lines.push(`- **枚举变化** \`${change.option}\``);
      if (change.added.length) {
        lines.push(`  - 新增值：${change.added.map(code).join("、")}`);
      }
      if (change.removed.length) {
        lines.push(`  - 删除值：${change.removed.map(code).join("、")}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function analyzePublicCliContractDiff(repositoryRoot) {
  const before = readHeadContract(repositoryRoot);
  const after = JSON.parse(readFileSync(resolve(repositoryRoot, contractPath), "utf8"));
  if (before === null) {
    return [
      "# Codex 公开 CLI 合同影响",
      "",
      `基线尚未记录；当前工作树初始化为 Codex CLI ${after.codexCli}。`,
      "后续升级将以本文件为基线报告参数和值的新增、删除与变化。",
      "",
    ].join("\n");
  }
  return renderPublicCliContractImpact(before, after);
}

function parseOptionBlocks(helpOutput) {
  const blocks = new Map();
  let current;
  for (const line of helpOutput.split(/\r?\n/u)) {
    const match = /^\s+(?:(-\w),\s+)?(--[a-z0-9-]+)(?:\s+(\S+))?\s*$/u.exec(line);
    if (match) {
      current = {
        aliases: match[1] ? [match[1]] : [],
        argument: match[3] || null,
        lines: [],
      };
      blocks.set(match[2], current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks;
}

function extractPossibleValues(lines) {
  const text = lines.join("\n");
  const inline = /\[possible values:\s*([^\]]+)\]/iu.exec(text);
  if (inline) {
    return inline[1].split(",").map((value) => value.trim()).filter(Boolean);
  }
  const marker = lines.findIndex((line) => /Possible values:/iu.test(line));
  if (marker < 0) return [];
  return lines.slice(marker + 1).flatMap((line) => {
    const match = /^\s*-\s+([^:\s]+)(?::|\s|$)/u.exec(line);
    return match ? [match[1]] : [];
  });
}

function renderOptionSignature(option, entry) {
  return [...entry.aliases, option, entry.argument].filter(Boolean).join(", ")
    .replace(/, (<[^>]+>(?:\.\.\.)?)$/u, " $1");
}

function normalizeOption(value) {
  return value && typeof value === "object"
    ? {
        present: value.present === true,
        aliases: Array.isArray(value.aliases) ? value.aliases : [],
        argument: typeof value.argument === "string" ? value.argument : null,
        values: Array.isArray(value.values) ? value.values : [],
      }
    : { present: false, aliases: [], argument: null, values: [] };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validateApprovalPolicy(value, keyPath, accepted, codexCli, configPath) {
  if (value === undefined) return;
  if (typeof value === "string" && accepted.includes(value)) return;
  throw new Error(
    `Codex 用户配置 ${keyPath} = ${JSON.stringify(value)} 不受 CLI ${codexCli} 支持；`
    + `请从 ${configPath} 删除该行后重新运行 codexc update`,
  );
}

function profileApprovalPolicyPath(name) {
  return /^[A-Za-z0-9_-]+$/u.test(name)
    ? `profiles.${name}.approval_policy`
    : `profiles[${JSON.stringify(name)}].approval_policy`;
}

function assertContract(contract) {
  if (
    !contract
    || contract.schemaVersion !== 1
    || typeof contract.codexCli !== "string"
    || !contract.options
    || typeof contract.options !== "object"
  ) {
    throw new Error("Codex 公开 CLI 合同格式无效");
  }
}

function readHeadContract(repositoryRoot) {
  try {
    const source = execFileSync("git", ["show", `HEAD:${contractPath}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function runCodex(codexBinary, args) {
  return execFileSync(codexBinary, args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function code(value) {
  return `\`${value}\``;
}

function main() {
  const [mode] = process.argv.slice(2);
  if (!["--check", "--check-user-settings", "--write"].includes(mode)) {
    throw new Error(
      "用法：node scripts/codex-public-cli-contract.mjs "
      + "<--check|--check-user-settings|--write>",
    );
  }
  const root = resolve(import.meta.dirname, "..");
  const path = resolve(root, contractPath);
  const actual = capturePublicCliContract(process.env.CODEX_BINARY || "codex");
  if (mode === "--write") {
    writePublicCliContract(path, actual);
    console.log(`Codex 公开 CLI 合同已更新：${actual.codexCli}`);
    return;
  }
  if (!existsSync(path)) throw new Error(`缺少 Codex 公开 CLI 合同：${path}`);
  const expected = JSON.parse(readFileSync(path, "utf8"));
  const changes = comparePublicCliContracts(expected, actual);
  if (expected.codexCli !== actual.codexCli || changes.length) {
    throw new Error(renderPublicCliContractImpact(expected, actual));
  }
  const approvalValues = normalizeOption(
    expected.options["--ask-for-approval"],
  ).values;
  if (!arraysEqual(approvalValues, supportedPublicApprovalPolicies)) {
    throw new Error(
      "Codex 公开审批合同已变化；请审查新增或删除值，并同步用户设置与 Remote 映射后再更新受控集合",
    );
  }
  if (mode === "--check-user-settings") {
    validateCodexUserSettingsFile(process.env, expected);
  }
  console.log(`Codex 公开 CLI 合同通过：${actual.codexCli}`);
}

function validateCodexUserSettingsFile(environment, contract) {
  const path = join(codexHomePath(environment), "config.toml");
  if (!existsSync(path)) return;
  let config;
  try {
    config = parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      `Codex 用户配置 ${path} 无法解析；请修正后重新运行 codexc update`,
    );
  }
  validateCodexUserSettingsAgainstContract(config, contract, path);
}

function arraysEqual(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
