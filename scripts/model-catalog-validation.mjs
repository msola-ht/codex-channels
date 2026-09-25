import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveCodexBinary, resolveExecutableInvocation } from "../runtime/executable.mjs";
import { writePrivateFileAtomic } from "../runtime/private-file.mjs";

export async function validateModelCatalogWithCodex(catalog, environment = process.env) {
  const maximumBytes = 2 * 1024 * 1024;
  const content = `${JSON.stringify(catalog, null, 2)}\n`;
  if (Buffer.byteLength(content) > maximumBytes) throw new Error("模型目录不能超过 2 MiB");
  const directory = await mkdtemp(join(tmpdir(), "codexc-model-catalog-"));
  try {
    const path = join(directory, "models.json");
    await writePrivateFileAtomic(path, content);
    const validationEnvironment = { ...environment, CODEX_HOME: directory };
    const invocation = resolveExecutableInvocation(
      effectiveCodexBinary("codex", environment),
      ["-c", `model_catalog_json=${JSON.stringify(path)}`, "debug", "models"],
      validationEnvironment,
    );
    const result = spawnSync(invocation.file, invocation.args, {
      cwd: directory, env: validationEnvironment,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      timeout: 30_000, maxBuffer: 8 * maximumBytes,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (result.error || result.status !== 0) throw new Error("模型目录未通过当前 Codex CLI 校验；请检查完整模型能力字段及 CLI 是否可运行");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
