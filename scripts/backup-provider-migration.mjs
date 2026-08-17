#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { connectHomePath, providerStorageRoot } from "../runtime/connect-home.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { managedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import {
  migrateManagedModelProviderFiles,
  migrateManagedModelProviderModelSettings,
  migrationPaths,
} from "./model-provider-file-layout.mjs";

export function backupAndMigrateProviderFiles(environment = process.env, options = {}) {
  const apply = options.apply === true;
  const codexHome = codexHomePath(environment);
  const storageRoot = providerStorageRoot(environment);
  const connectHome = connectHomePath(environment);
  const backupRoot = options.backupDirectory ?? join(
    connectHome,
    "backups",
    `provider-migration-${timestamp(options.now ?? (() => new Date()))}`,
  );
  const entries = migrationPaths(environment);
  const legacyByProvider = new Map();
  for (const entry of entries) {
    if (!existsSync(entry.legacy)) continue;
    const id = entry.definition?.id ?? "shared";
    const files = legacyByProvider.get(id) ?? [];
    files.push(entry.legacy);
    legacyByProvider.set(id, files);
  }
  const legacyFiles = [...legacyByProvider.values()].flat();
  const currentFiles = unique(entries.map((entry) => entry.current)).filter(existsSync);
  const providerDirectories = managedModelProviderDefinitions
    .map((definition) => join(storageRoot, definition.id))
    .filter((path) => existsSync(path));
  const referenceFiles = [
    join(codexHome, "config.toml"),
    ...managedModelProviderDefinitions.map((definition) =>
      join(codexHome, definition.profileFileName)),
    join(codexHome, "sf-agent.config.toml"),
  ].filter((path) => existsSync(path));

  if (legacyFiles.length === 0) {
    return {
      status: "already-migrated",
      backupDirectory: undefined,
      movedDirectories: [],
      layout: undefined,
      settings: undefined,
    };
  }

  if (!apply) {
    return {
      status: "dry-run",
      backupDirectory: backupRoot,
      legacyFiles,
      currentFiles,
      providerDirectories,
      referenceFiles,
    };
  }

  if (existsSync(backupRoot)) {
    throw new Error(`备份目录已存在，拒绝覆盖：${backupRoot}`);
  }
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });

  const copied = [];
  const copyFile = (source, target) => {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, { recursive: false });
    copied.push({ source, target });
  };
  const copyDirectory = (source, target) => {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, { recursive: true });
    copied.push({ source, target });
  };

  for (const path of legacyFiles) {
    copyFile(path, join(backupRoot, "codex-home", relative(codexHome, path)));
  }
  for (const directory of providerDirectories) {
    copyDirectory(directory, join(backupRoot, "providers", basename(directory)));
  }
  for (const path of currentFiles) {
    if (providerDirectories.some((directory) => path.startsWith(`${directory}${sep}`))) {
      continue;
    }
    copyFile(path, resolveBackupTarget(backupRoot, { codexHome, connectHome }, path));
  }
  for (const path of referenceFiles) {
    copyFile(path, join(backupRoot, "reference", relative(codexHome, path)));
  }

  for (const { target } of copied) {
    if (!existsSync(target)) {
      throw new Error(`备份校验失败，未开始迁移：${target}`);
    }
  }

  const movedDirectories = [];
  for (const definition of managedModelProviderDefinitions) {
    if (!legacyByProvider.has(definition.id)) continue;
    const directory = join(storageRoot, definition.id);
    if (!existsSync(directory)) continue;
    const target = join(backupRoot, "original-providers", definition.id);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(directory, target);
    movedDirectories.push({ provider: definition.id, from: directory, to: target });
  }

  let layout;
  let settings;
  try {
    layout = migrateManagedModelProviderFiles(environment);
    settings = migrateManagedModelProviderModelSettings(environment);
  } catch (error) {
    for (const moved of movedDirectories) {
      const fromEmpty = existsSync(moved.from)
        && readdirSync(moved.from).length === 0;
      if (existsSync(moved.to) && (!existsSync(moved.from) || fromEmpty)) {
        if (fromEmpty) rmdirSync(moved.from);
        renameSync(moved.to, moved.from);
      }
    }
    throw error;
  }

  writeManifest(backupRoot, {
    backupDirectory: backupRoot,
    codexHome,
    copied,
    movedDirectories,
    layout,
    settings,
  });

  return {
    status: "migrated",
    backupDirectory: backupRoot,
    movedDirectories,
    layout,
    settings,
    copied,
  };
}

export function resolveBackupTarget(
  backupRoot,
  { codexHome, connectHome },
  path,
) {
  if (path.startsWith(`${codexHome}${sep}`)) {
    return join(backupRoot, "codex-home", assertInside(codexHome, path));
  }
  if (path.startsWith(`${connectHome}${sep}`)) {
    return join(backupRoot, "other", assertInside(connectHome, path));
  }
  throw new Error(`备份目标不在受管目录内，拒绝迁移：${path}`);
}

function assertInside(root, path) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`备份目标超出受管目录，拒绝迁移：${path}`);
  }
  return rel;
}

function writeManifest(backupDirectory, value) {
  writeFileSync(
    join(backupDirectory, "backup-manifest.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function timestamp(now) {
  return now().toISOString().replace(/[:.]/g, "-");
}

function unique(values) {
  return [...new Set(values)];
}

function printPlan(result) {
  console.log(`备份目录（预演，不会写入）：${result.backupDirectory}`);
  console.log(`旧布局文件：${result.legacyFiles.length} 个`);
  for (const path of result.legacyFiles) console.log(`  ${path}`);
  console.log(`现有新布局 Provider 目录：${result.providerDirectories.length} 个`);
  for (const path of result.providerDirectories) console.log(`  ${path}`);
  console.log(`将被改写引用的文件：${result.referenceFiles.length} 个`);
  for (const path of result.referenceFiles) console.log(`  ${path}`);
  console.log("确认无误后运行：node scripts/backup-provider-migration.mjs --apply");
}

function printResult(result) {
  writeCliMessage("success", `第三方 Provider 文件已备份并迁移。`);
  console.log(`备份目录：${result.backupDirectory}`);
  for (const moved of result.movedDirectories) {
    console.log(`已移出现有 Provider 目录：${moved.from} -> ${moved.to}`);
  }
  if (result.layout.changed) {
    console.log(`布局迁移：${result.layout.moved.length} 项`);
  } else {
    console.log("布局迁移：无变化");
  }
  if (result.settings.changed) {
    console.log(`模型设置迁移：${result.settings.updated.length} 个文件`);
  } else {
    console.log("模型设置迁移：无变化");
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("-h") || args.includes("--help")) {
      console.log(
        "用法：node scripts/backup-provider-migration.mjs [--dry-run|--apply]"
        + "\n默认只预演；--apply 先备份旧布局与现有新目录，再执行迁移。",
      );
    } else if (args.includes("--apply")) {
      printResult(backupAndMigrateProviderFiles(process.env, { apply: true }));
    } else {
      printPlan(backupAndMigrateProviderFiles(process.env, { apply: false }));
    }
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
