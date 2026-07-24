import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

export function analyzeProtocolDiff(repositoryRoot, changedFiles) {
  const files = changedFiles
    .split(/\r?\n/u)
    .map((entry) => entry.split("\t").at(-1))
    .filter((path) =>
      path?.startsWith("src/codex-protocol/generated/")
      && path.endsWith(".ts"));
  const methodFiles = [
    "src/codex-protocol/generated/ClientRequest.ts",
    "src/codex-protocol/generated/ClientNotification.ts",
    "src/codex-protocol/generated/ServerNotification.ts",
    "src/codex-protocol/generated/ServerRequest.ts",
  ];
  const methodChanges = methodFiles.flatMap((path) => {
    const before = readHeadFile(repositoryRoot, path);
    const after = readWorktreeFile(repositoryRoot, path);
    const oldMethods = extractMethods(before);
    const newMethods = extractMethods(after);
    const added = [...newMethods].filter((method) => !oldMethods.has(method));
    const removed = [...oldMethods].filter((method) => !newMethods.has(method));
    return added.length || removed.length ? [{ path, added, removed }] : [];
  });
  const fieldChanges = files.flatMap((path) => compareTopLevelTypeFields(
    readHeadFile(repositoryRoot, path),
    readWorktreeFile(repositoryRoot, path),
    path,
  ));

  return renderProtocolImpact(files, methodChanges, fieldChanges);
}

function readHeadFile(repositoryRoot, path) {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function readWorktreeFile(repositoryRoot, path) {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
}

function extractMethods(source) {
  return new Set(
    [...source.matchAll(/["']method["']\s*:\s*["']([^"']+)["']/gu)]
      .map((match) => match[1]),
  );
}

function compareTopLevelTypeFields(before, after, path) {
  const oldTypes = extractTopLevelTypeFields(before);
  const newTypes = extractTopLevelTypeFields(after);
  const changes = [];
  const typeNames = new Set([...oldTypes.keys(), ...newTypes.keys()]);
  for (const typeName of typeNames) {
    const newFields = newTypes.get(typeName) || new Map();
    const oldFields = oldTypes.get(typeName) || new Map();
    for (const [fieldName, field] of newFields) {
      const previous = oldFields.get(fieldName);
      if (!previous) {
        changes.push({
          path,
          typeName,
          fieldName,
          kind: field.optional ? "optional-added" : "required-added",
          type: field.type,
        });
      } else if (
        previous.type !== field.type
        || previous.optional !== field.optional
      ) {
        changes.push({
          path,
          typeName,
          fieldName,
          kind: "changed",
          type: `${previous.optional ? "?" : ""}${previous.type} → `
            + `${field.optional ? "?" : ""}${field.type}`,
        });
      }
    }
    for (const [fieldName, field] of oldFields) {
      if (!newFields.has(fieldName)) {
        changes.push({
          path,
          typeName,
          fieldName,
          kind: "removed",
          type: field.type,
        });
      }
    }
  }
  return changes;
}

function extractTopLevelTypeFields(source) {
  const types = new Map();
  if (!source) {
    return types;
  }
  const sourceFile = ts.createSourceFile(
    "generated.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    if (
      !ts.isTypeAliasDeclaration(statement)
      || !ts.isTypeLiteralNode(statement.type)
    ) {
      continue;
    }
    const fields = new Map();
    for (const member of statement.type.members) {
      if (
        !ts.isPropertySignature(member)
        || !member.type
        || (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))
      ) {
        continue;
      }
      fields.set(member.name.text, {
        optional: Boolean(member.questionToken),
        type: member.type.getText(sourceFile),
      });
    }
    types.set(statement.name.text, fields);
  }
  return types;
}

function renderProtocolImpact(files, methodChanges, fieldChanges) {
  const lines = [
    "# Codex App Server 协议影响",
    "",
    "本报告只描述生成协议的结构变化；行为语义仍需对照目标版本官方源码和测试审查。",
    "",
    "## RPC 方法",
    "",
  ];
  if (!methodChanges.length) {
    lines.push("没有检测到 RPC 方法名称增删。");
  } else {
    for (const change of methodChanges) {
      lines.push(`- \`${change.path}\``);
      for (const method of change.added) {
        lines.push(`  - 新增：\`${method}\``);
      }
      for (const method of change.removed) {
        lines.push(`  - 删除：\`${method}\``);
      }
    }
  }
  lines.push("", "## 顶层类型字段", "");
  if (!fieldChanges.length) {
    lines.push("没有检测到可自动识别的顶层类型字段变化。");
  } else {
    const labels = {
      "required-added": "新增必填",
      "optional-added": "新增可选",
      changed: "类型或可选性变化",
      removed: "删除",
    };
    for (const change of fieldChanges) {
      lines.push(
        `- **${labels[change.kind]}** \`${change.typeName}.${change.fieldName}\`: `
        + `\`${change.type}\`（\`${change.path}\`）`,
      );
    }
  }
  lines.push("", "## 变更的生成文件", "");
  lines.push(...(files.length
    ? files.map((path) => `- \`${path}\``)
    : ["没有生成协议文件变化。"]));
  lines.push("");
  return lines.join("\n");
}
