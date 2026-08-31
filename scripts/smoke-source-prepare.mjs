import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { packageDir } from "./package-path.mjs";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "codexc-source-prepare-"));
const sourceDirectory = join(temporaryDirectory, "source");
const sourceEntries = new Set([
  "bin",
  "launchd",
  "package-lock.json",
  "package.json",
  "runtime",
  "scripts",
  "src",
  "systemd",
  "tsconfig.build.json",
  "tsconfig.json",
  "webui",
]);

try {
  cpSync(packageDir, sourceDirectory, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(packageDir.length + 1);
      const [topLevel] = relative.split("/");
      if (relative === "") return true;
      if (topLevel === "webui") {
        return !["node_modules", "dist"].includes(relative.split("/")[1]);
      }
      return sourceEntries.has(topLevel);
    },
  });
  for (const path of [
    "dist",
    "node_modules",
    join("webui", "dist"),
    join("webui", "node_modules"),
  ]) {
    if (existsSync(join(sourceDirectory, path))) {
      throw new Error(`干净源码副本不应包含 ${path}`);
    }
  }
  const installEnvironment = {
    ...process.env,
    npm_config_cache: join(temporaryDirectory, "npm-cache"),
    npm_config_prefix: join(temporaryDirectory, "global"),
  };
  const installInvocation = resolveExecutableInvocation(
    "npm",
    ["run", "install:global"],
    installEnvironment,
  );
  const result = spawnSync(
    installInvocation.file,
    installInvocation.args,
    {
      cwd: sourceDirectory,
      env: installEnvironment,
      encoding: "utf8",
      windowsVerbatimArguments: installInvocation.windowsVerbatimArguments,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `干净源码全局安装失败：exit=${result.status ?? 1}\n${result.stderr || result.stdout}`,
    );
  }
  if (!existsSync(join(sourceDirectory, "dist", "main.js"))) {
    throw new Error("干净源码全局安装后缺少 dist/main.js");
  }
  if (!existsSync(join(sourceDirectory, "webui", "dist", "index.html"))) {
    throw new Error("干净源码全局安装后缺少 webui/dist/index.html");
  }
  const command = join(temporaryDirectory, "global", "bin", "codexc");
  if (!existsSync(command)) {
    throw new Error("干净源码全局安装后缺少 codexc 命令");
  }
  const installedPackage = join(
    temporaryDirectory,
    "global",
    "lib",
    "node_modules",
    "@hegenai",
    "codexc",
  );
  if (!existsSync(installedPackage) || lstatSync(installedPackage).isSymbolicLink()) {
    throw new Error("干净源码全局安装仍链接到源码目录");
  }
  const commandInvocation = resolveExecutableInvocation(command, ["--version"]);
  const invoked = spawnSync(commandInvocation.file, commandInvocation.args, {
    cwd: sourceDirectory,
    encoding: "utf8",
    windowsVerbatimArguments: commandInvocation.windowsVerbatimArguments,
  });
  if (invoked.error) {
    throw invoked.error;
  }
  const expectedVersion = JSON.parse(
    readFileSync(join(sourceDirectory, "package.json"), "utf8"),
  ).version;
  if (invoked.status !== 0 || invoked.stdout.trim() !== expectedVersion) {
    throw new Error(
      `干净源码全局命令不可用：exit=${invoked.status ?? 1}\n${invoked.stderr || invoked.stdout}`,
    );
  }
  console.log("干净源码全局安装冒烟通过");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
