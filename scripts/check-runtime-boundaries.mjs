import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceDirectories = ["runtime", "scripts", "bin"];
const allowedTargets = new Map([
  ["runtime", new Set(["runtime", "dist"])],
  ["scripts", new Set(["scripts", "runtime", "dist"])],
  ["bin", new Set(["bin", "scripts", "runtime"])],
]);
const allowedDistEntries = new Map([
  ["runtime", new Set([
    "dist/codex-client/index.js",
    "dist/provider-proxy/index.js",
  ])],
  ["scripts", new Set([
    "dist/codex-client/index.js",
    "dist/config/index.js",
    "dist/observability/index.js",
    "dist/observability/query/index.js",
    "dist/scheduled-tasks/index.js",
    "dist/storage/index.js",
    "dist/surfaces/index.js",
    "dist/surfaces/feishu/index.js",
    "dist/surfaces/token-format.js",
    "dist/surfaces/elapsed-duration.js",
    "dist/surfaces/weixin/index.js",
  ])],
  ["bin", new Set()],
]);
const failures = [];

for (const sourceDirectory of sourceDirectories) {
  const directory = resolve(root, sourceDirectory);
  for (const file of sourceFiles(directory)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      checkRelativeImport(sourceDirectory, file, specifier);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("运行时目录依赖检查通过：runtime <- scripts <- bin，dist 仅使用显式允许入口");

function checkRelativeImport(sourceDirectory, file, specifier) {
  const target = resolve(dirname(file), specifier);
  const targetPath = relative(root, target).replaceAll("\\", "/");
  if (targetPath.startsWith("..") || isAbsolute(targetPath)) {
    failures.push(`${display(file)} -> ${specifier} 超出项目根目录`);
    return;
  }
  const [targetDirectory] = targetPath.split("/");
  if (!allowedTargets.get(sourceDirectory)?.has(targetDirectory)) {
    failures.push(
      `${display(file)} -> ${specifier} 违反 ${sourceDirectory} 目录依赖方向`,
    );
    return;
  }
  if (targetDirectory !== "dist") return;
  if (!allowedDistEntries.get(sourceDirectory)?.has(targetPath)) {
    failures.push(`${display(file)} -> ${specifier} 未列入 ${sourceDirectory} 的已编译入口允许表`);
    return;
  }
  const sourceEntry = resolve(
    root,
    targetPath.replace(/^dist\//u, "src/").replace(/\.js$/u, ".ts"),
  );
  if (!existsSync(sourceEntry)) {
    failures.push(`${display(file)} -> ${specifier} 指向不存在的 src 编译入口`);
  }
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:mjs|mts|ts)$/u.test(entry.name) ? [path] : [];
  });
}

function importSpecifiers(source) {
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
    ...source.matchAll(/\bimport\s+["']([^"']+)["']/gu),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/gu),
  ].map((match) => match[1]).filter(Boolean);
}

function display(file) {
  return relative(root, file);
}
