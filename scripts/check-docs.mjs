import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
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
checkProtocolIndexMetrics();
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
    .filter((file) =>
      file.endsWith(".md") && !file.startsWith(".codex/skills/"))
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
  const index = readFileSync(join(root, "index.md"), "utf8");
  for (const target of [
    "README.md",
    "docs/index.md",
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
    if (!index.includes(`](${target})`)) {
      failures.push(`index.md 文档索引缺少 ${target}`);
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

function checkProtocolIndexMetrics() {
  const index = readFileSync(join(root, "docs/index.md"), "utf8");
  const generatedPrefix = "src/codex-protocol/generated/";
  const generatedFiles = trackedFiles.filter(
    (file) => file.startsWith(generatedPrefix) && file.endsWith(".ts"),
  );
  const methodCount = (file) =>
    [...readFileSync(join(root, file), "utf8").matchAll(/"method": "[^"]+"/gu)].length;
  const clientRequests = readFileSync(
    join(root, "src/codex-client/client.ts"),
    "utf8",
  );
  const directRequests = new Set(
    [...clientRequests.matchAll(
      /this\.rpc\.request(?:<[\s\S]*?>)?\(\s*\{\s*method:\s*"([^"]+)"/gu,
    )]
      .map((match) => match[1]),
  );
  const serverRequestMethods = new Set(
    [...readFileSync(
      join(root, "src/codex-protocol/generated/ServerRequest.ts"),
      "utf8",
    ).matchAll(/"method": "([^"]+)"/gu)].map((match) => match[1]),
  );
  const approvalCases = new Set(
    [...readFileSync(
      join(root, "src/codex-client/server-request-adapter.ts"),
      "utf8",
    ).matchAll(/"([^"]+)"/gu)]
      .map((match) => match[1])
      .filter((method) => serverRequestMethods.has(method)),
  );
  const metrics = [
    [generatedFiles.length, "当前 CLI 生成的 TypeScript 文件总数"],
    [
      generatedFiles.filter((file) =>
        !file.slice(generatedPrefix.length).includes("/")).length,
      "生成目录根层的公共、兼容和初始化类型",
    ],
    [
      generatedFiles.filter((file) => file.startsWith(`${generatedPrefix}v2/`)).length,
      "v2 请求、响应、通知和数据类型",
    ],
    [
      generatedFiles.filter((file) =>
        file.startsWith(`${generatedPrefix}serde_json/`)).length,
      "`serde_json` 辅助类型",
    ],
    [
      methodCount("src/codex-protocol/generated/ClientRequest.ts"),
      "客户端发给 App Server 的 Request 方法",
    ],
    [
      methodCount("src/codex-protocol/generated/ServerNotification.ts"),
      "App Server 发给客户端的 Notification 方法",
    ],
    [
      methodCount("src/codex-protocol/generated/ServerRequest.ts"),
      "App Server 发给客户端、需要回应的 Request 方法",
    ],
    [
      methodCount("src/codex-protocol/generated/ClientNotification.ts"),
      "客户端发给 App Server 的 Notification",
    ],
    [
      [...readFileSync(
        join(root, "src/codex-protocol/index.ts"),
        "utf8",
      ).matchAll(/^export type /gmu)].length,
      "Codex Client 适配边界使用的受控协议类型导出",
    ],
    [directRequests.size, "本项目直接调用的业务 Request 方法"],
    [approvalCases.size, "本项目显式协调的 Server Request 类型"],
    [
      readdirSync(join(root, "src"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length,
      "本项目 TypeScript Gateway 的一级业务模块",
    ],
  ];
  for (const [count, label] of metrics) {
    if (!index.includes(`| ${count} | ${label}`)) {
      failures.push(`docs/index.md 协议数字不一致：${label} 应为 ${count}`);
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
