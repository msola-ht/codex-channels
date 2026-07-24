import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packageDir } from "./package-path.mjs";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "codexc-source-prepare-"));
const sourceDirectory = join(temporaryDirectory, "source");

try {
  mkdirSync(join(sourceDirectory, "scripts"), { recursive: true });
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
  ]) {
    cpSync(join(packageDir, path), join(sourceDirectory, path));
  }
  for (const path of ["src", "runtime"]) {
    cpSync(join(packageDir, path), join(sourceDirectory, path), {
      recursive: true,
    });
  }
  for (const path of [
    "clean-dist.mjs",
    "install-git-hooks.mjs",
    "package-path.mjs",
    "prepare-package.mjs",
  ]) {
    cpSync(
      join(packageDir, "scripts", path),
      join(sourceDirectory, "scripts", path),
    );
  }
  const result = spawnSync(
    process.execPath,
    [join(sourceDirectory, "scripts", "prepare-package.mjs")],
    {
      cwd: sourceDirectory,
      env: {
        ...process.env,
        npm_config_cache: join(temporaryDirectory, "npm-cache"),
      },
      encoding: "utf8",
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `干净源码 prepare 失败：exit=${result.status ?? 1}\n${result.stderr || result.stdout}`,
    );
  }
  if (!existsSync(join(sourceDirectory, "dist", "main.js"))) {
    throw new Error("干净源码 prepare 后缺少 dist/main.js");
  }
  console.log("干净源码 prepare 冒烟通过");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
