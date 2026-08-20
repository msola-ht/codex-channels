import { spawn } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");

export const defaultUpgradeValidationStages = [
  {
    id: "protocol-check",
    name: "协议一致性",
    command: "npm",
    args: ["run", "protocol:check"],
  },
  {
    id: "typecheck",
    name: "TypeScript 与版本",
    command: "npm",
    args: ["run", "check"],
  },
  {
    id: "lint",
    name: "Lint",
    command: "npm",
    args: ["run", "lint"],
  },
  {
    id: "docs-check",
    name: "文档与索引",
    skipReason: "协议预览不修改稳定版文档；完成正式业务适配后由 verify:commit 执行",
  },
  {
    id: "unit-tests",
    name: "测试（不含发布前 README 同步）",
    command: "npm",
    args: ["test", "--", "--exclude", "tests/release-readme-sync.test.ts"],
  },
  {
    id: "contract-tests",
    name: "真实 App Server 合同",
    command: "npm",
    args: ["test", "--", "--run", "tests/real-app-server.test.ts"],
    environment: { RUN_CODEX_CONTRACT: "1" },
  },
  {
    id: "build",
    name: "生产构建",
    command: "npm",
    args: ["run", "build"],
  },
  {
    id: "package-test",
    name: "npm 打包与源码安装冒烟",
    command: "npm",
    args: ["run", "test:package"],
  },
];

export async function runUpgradeValidationStages(
  stages,
  outputDirectory,
  options = {},
) {
  const output = resolve(outputDirectory);
  const logs = resolve(output, "logs");
  mkdirSync(logs, { recursive: true });
  const results = [];

  for (const stage of stages) {
    const result = stage.skipReason
      ? {
          id: stage.id,
          name: stage.name,
          status: "skipped",
          exitCode: null,
          durationMs: 0,
          log: null,
          reason: stage.skipReason,
        }
      : await runStage(stage, logs, options);
    results.push(result);
  }

  const document = {
    schemaVersion: 1,
    result: results.every((stage) =>
      stage.status === "passed" || stage.status === "skipped")
      ? "success"
      : "failure",
    stages: results,
  };
  writeFileSync(
    resolve(output, "validation-results.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  return document;
}

async function runStage(stage, logsDirectory, options) {
  const startedAt = Date.now();
  const logName = `${stage.id}.log`;
  const logPath = resolve(logsDirectory, logName);
  const stream = createWriteStream(logPath, { flags: "w", mode: 0o600 });
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let outputTail = "";

  stdout.write(`\n[升级验证] ${stage.name}\n`);
  const status = await new Promise((complete) => {
    const child = spawn(stage.command, stage.args, {
      cwd: options.cwd || root,
      env: {
        ...process.env,
        ...options.environment,
        ...stage.environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout.write(chunk);
      stream.write(chunk);
      outputTail = appendOutputTail(outputTail, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.write(chunk);
      stream.write(chunk);
      outputTail = appendOutputTail(outputTail, chunk);
    });
    child.on("error", (error) => {
      const message = `无法启动验证命令：${error.message}\n`;
      stderr.write(message);
      stream.write(message);
      complete({ status: "error", exitCode: null, error: error.message });
    });
    child.on("close", (exitCode) => {
      complete({
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
      });
    });
  });

  await new Promise((complete) => stream.end(complete));
  return {
    id: stage.id,
    name: stage.name,
    ...status,
    durationMs: Date.now() - startedAt,
    log: `logs/${logName}`,
    ...(status.status === "passed"
      ? {}
      : { failureSummary: outputTail.trim() || status.error || "命令执行失败" }),
  };
}

function appendOutputTail(current, chunk) {
  const combined = current + chunk.toString();
  return combined.length > 4000 ? combined.slice(-4000) : combined;
}

async function main() {
  const [outputDirectory] = process.argv.slice(2);
  if (!outputDirectory) {
    throw new Error(
      "用法：node scripts/run-upgrade-validation.mjs <报告目录>",
    );
  }
  const result = await runUpgradeValidationStages(
    defaultUpgradeValidationStages,
    outputDirectory,
  );
  process.exitCode = result.result === "success" ? 0 : 1;
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
