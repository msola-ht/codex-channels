import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

export function generateProtocolTree(codex, root, outputParent, options = {}) {
  mkdirSync(outputParent, { recursive: true });
  const generated = mkdtempSync(join(outputParent, ".generated-"));
  try {
    execFileSync(codex, ["app-server", "generate-ts", "--out", generated], {
      cwd: root,
      stdio: options.stdio ?? "inherit",
    });
    return generated;
  } catch (error) {
    rmSync(generated, { recursive: true, force: true });
    throw error;
  }
}

export function assertProtocolTreesEqual(expected, actual) {
  const expectedFiles = relativeFiles(expected);
  const actualFiles = relativeFiles(actual);
  if (expectedFiles.join("\n") !== actualFiles.join("\n")) {
    throw new Error(
      `生成协议文件列表不一致\n当前：${expectedFiles.join(", ")}\n重新生成：${actualFiles.join(", ")}`,
    );
  }
  for (const file of expectedFiles) {
    const expectedContent = readFileSync(join(expected, file));
    const actualContent = readFileSync(join(actual, file));
    if (!expectedContent.equals(actualContent)) {
      throw new Error(`生成协议内容不一致：${file}`);
    }
  }
}

export function replaceProtocolTree(generated, output) {
  const outputParent = dirname(output);
  const backup = mkdtempSync(join(outputParent, ".generated-backup-"));
  rmSync(backup, { recursive: true });
  const hadOutput = existsSync(output);
  if (hadOutput) {
    renameSync(output, backup);
  }
  try {
    renameSync(generated, output);
  } catch (error) {
    if (hadOutput && !existsSync(output)) {
      renameSync(backup, output);
    }
    throw error;
  }
  if (hadOutput) {
    rmSync(backup, { recursive: true, force: true });
  }
}

function relativeFiles(root) {
  const files = [];
  visit(root);
  return files.sort();

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path));
      }
    }
  }
}
