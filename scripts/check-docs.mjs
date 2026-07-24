import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];
const trackedFiles = repositoryFiles();
const markdownFiles = repositoryMarkdownFiles();

for (const file of markdownFiles) {
  checkMarkdownLinks(file);
}

checkRootIndex();
checkSourceIndex();
for (const directory of [
  "bin",
  "runtime",
  "scripts",
  "launchd",
  "systemd",
  ".github/workflows",
  ".githooks",
]) {
  checkDirectoryFileIndex(directory);
}
checkRemovedDocumentationNames();

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`文档检查通过：${markdownFiles.length} 个 Markdown 文件，索引与本地链接一致`);

function repositoryMarkdownFiles() {
  return trackedFiles
    .filter((file) => file.endsWith(".md"))
    .map((file) => resolve(root, file))
    .filter(existsSync);
}

function repositoryFiles() {
  const staged = execFileSync(
    "git",
    ["diff", "--cached", "--name-only"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const args = staged
    ? ["ls-files", "--cached"]
    : ["ls-files", "--cached", "--others", "--exclude-standard"];
  const output = execFileSync(
    "git",
    args,
    { cwd: root, encoding: "utf8" },
  );
  return output
    .split(/\r?\n/)
    .filter(Boolean);
}

function checkMarkdownLinks(file) {
  const content = readFileSync(file, "utf8");
  for (const match of content.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    const target = localLinkTarget(match[1]);
    if (!target) {
      continue;
    }
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) {
      failures.push(`${display(file)} 包含失效链接：${match[1]}`);
    }
  }
}

function localLinkTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  } else {
    target = target.split(/\s+["']/u, 1)[0];
  }
  target = target.split("#", 1)[0];
  if (!target || /^[a-z][a-z\d+.-]*:/iu.test(target)) {
    return undefined;
  }
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function checkRootIndex() {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const target of [
    "config.example.toml",
    "src/README.md",
    "bin/README.md",
    "scripts/README.md",
    "runtime/README.md",
    "launchd/README.md",
    "systemd/README.md",
    "tests/README.md",
    ".githooks/README.md",
    ".github/workflows/README.md",
  ]) {
    if (!readme.includes(`](${target})`)) {
      failures.push(`README.md 文档索引缺少 ${target}`);
    }
  }
}

function checkSourceIndex() {
  const sourceRoot = join(root, "src");
  const readme = readFileSync(join(sourceRoot, "README.md"), "utf8");
  const modules = trackedFiles
    .map((file) => file.match(/^src\/([^/]+)\/README\.md$/u)?.[1])
    .filter((name) => name !== undefined);
  for (const moduleName of modules) {
    if (!readme.includes(`](${moduleName}/README.md)`)) {
      failures.push(`src/README.md 模块索引缺少 ${moduleName}/`);
    }
  }
}

function checkDirectoryFileIndex(directory) {
  const directoryPath = join(root, directory);
  const readmePath = join(directoryPath, "README.md");
  if (!existsSync(readmePath)) {
    failures.push(`${directory}/ 缺少 README.md`);
    return;
  }
  const readme = readFileSync(readmePath, "utf8");
  const files = trackedFiles
    .filter((file) => dirname(file) === directory && file !== `${directory}/README.md`)
    .map((file) => file.slice(directory.length + 1));
  for (const file of files) {
    if (!readme.includes(`\`${file}\``)) {
      failures.push(`${directory}/README.md 文件索引缺少 ${file}`);
    }
  }
}

function checkRemovedDocumentationNames() {
  const removedNames = [
    ".env.example",
    "CODEX_CONNECT_ENV_FILE",
    "doctor --fix",
  ];
  for (const file of markdownFiles) {
    const content = readFileSync(file, "utf8");
    for (const name of removedNames) {
      if (content.includes(name)) {
        failures.push(`${display(file)} 仍包含已移除名称 ${name}`);
      }
    }
  }
}

function display(file) {
  return relative(root, file);
}
