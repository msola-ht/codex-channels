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
    "dist/model-relay/index.js",
    "dist/observability/index.js", // Service owners reuse the shared safe logger.
  ])],
  ["scripts", new Set([
    "dist/codex-client/index.js",
    "dist/config/index.js",
    "dist/delivery/index.js",
    "dist/observability/index.js",
    "dist/observability/query/index.js",
    "dist/scheduled-tasks/index.js",
    "dist/storage/index.js",
    "dist/surfaces/delivery-diagnostics/index.js", // Offline policy only; never load platform SDKs.
    "dist/surfaces/feishu/index.js",
    "dist/surfaces/token-format.js",
    "dist/surfaces/elapsed-duration.js",
    "dist/surfaces/weixin/index.js",
  ])],
  ["bin", new Set()],
]);
const failures = [];
const sourceRoot = resolve(root, "src");
const allowedModuleDependencies = new Map(Object.entries({
  application: ["conversation-core", "policy", "scheduled-tasks", "session-routing"],
  approval: ["conversation-core", "session-routing"],
  bootstrap: ["application", "approval", "codex-client", "config", "conversation-core", "event-bus",
    "delivery", "observability", "policy", "provider-proxy", "scheduled-tasks", "session-routing", "storage", "surfaces"],
  "codex-client": ["approval", "application", "codex-protocol", "conversation-core", "session-routing"],
  "codex-protocol": [],
  config: [],
  "conversation-core": ["event-bus"],
  "event-bus": [],
  delivery: [],
  "model-api": [],
  "model-relay": ["model-api", "provider-proxy"],
  "provider-proxy": ["model-api"],
  observability: ["config"],
  policy: ["conversation-core"],
  "scheduled-tasks": [],
  "session-routing": ["conversation-core", "policy", "storage"],
  storage: ["conversation-core"],
  surfaces: ["application", "approval", "config", "conversation-core", "event-bus", "policy"],
}));
const runtimeImporters = new Set([
  "bootstrap", "config", "delivery", "observability", "provider-proxy", "scheduled-tasks", "storage", "surfaces",
]);
const runtimeExceptions = new Map([
  // Pure service-tier semantics shared with CLI and WebUI; no runtime lifecycle dependency.
  ["src/application/model-selection-service.ts", new Set(["runtime/service-tier.mjs"])],
  ["src/model-api/chat-request.ts", new Set(["runtime/chat-reasoning.mjs"])],
  ["src/model-api/responses-request.ts", new Set(["runtime/chat-reasoning.mjs"])],
  ["src/model-relay/server.ts", new Set(["runtime/model-relay-listen-host.mjs", "runtime/model-relay-model-id.mjs"])],
  ["src/model-relay/admission.ts", new Set(["runtime/model-relay-model-id.mjs"])],
  ["src/codex-client/unix-websocket-transport.ts", new Set(["runtime/app-server-unix-socket.mjs"])],
]);
const unsupportedProtocolMethods = [
  "thread/search", "thread/searchOccurrences", "thread/items/list", "thread/rollback",
  "plugin/list", "plugin/search", "plugin/read", "plugin/skill/read", "plugin/share/save",
  "plugin/share/updateTargets", "plugin/share/list", "plugin/share/checkout", "plugin/share/delete",
  "plugin/install", "plugin/uninstall", "marketplace/add", "marketplace/remove", "marketplace/upgrade",
];

checkSourceBoundaries();

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

console.log("模块与运行时依赖检查通过：模块允许表、公开入口、无循环、Surface 隔离与运行时目录依赖");

function checkSourceBoundaries() {
  const moduleNames = new Set(readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name));
  const graph = new Map([...moduleNames].map(name => [name, new Set()]));
  const importedProtocolNames = new Set();
  for (const name of moduleNames) {
    if (!allowedModuleDependencies.has(name)) failures.push(`src/${name} 未声明模块依赖`);
  }
  for (const [name, dependencies] of allowedModuleDependencies) {
    if (!moduleNames.has(name)) failures.push(`src/${name} 模块不存在`);
    for (const dependency of dependencies) {
      if (!moduleNames.has(dependency)) failures.push(`src/${name} 未知依赖 ${dependency}`);
    }
  }
  for (const file of sourceFiles(sourceRoot).filter(path => path.endsWith(".ts"))) {
    const sourcePath = display(file).replaceAll("\\", "/");
    const sourceModule = topLevelModule(file, moduleNames);
    const source = readFileSync(file, "utf8");
    if (sourceModule === "surfaces" && source.includes("ConversationService")) {
      failures.push(`${sourcePath} 依赖具体 ConversationService`);
    }
    if (sourceModule === "codex-client") {
      if (source.includes('"thread/realtime/')) failures.push(`${sourcePath} 使用未支持的 realtime API`);
      for (const method of unsupportedProtocolMethods) {
        if (source.includes(`"${method}"`)) failures.push(`${sourcePath} 使用未支持的协议方法 ${method}`);
      }
      for (const match of source.matchAll(/import(?: type)?\s*\{([^}]*)\}\s*from "\.\.\/codex-protocol\/index\.js";/gsu)) {
        for (const name of match[1].split(",").map(value => value.trim().split(/\s+as\s+/u, 1)[0]).filter(Boolean)) {
          importedProtocolNames.add(name);
        }
      }
    }
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      const targetPath = display(target).replaceAll("\\", "/");
      const targetModule = topLevelModule(target, moduleNames);
      if (["bin", "scripts"].some(directory => isInside(resolve(root, directory), target))) {
        failures.push(`${sourcePath} -> ${specifier} 生产代码依赖 CLI 或项目脚本`);
      }
      if (isInside(resolve(root, "runtime"), target) && !runtimeImporters.has(sourceModule)
        && !runtimeExceptions.get(sourcePath)?.has(targetPath)) {
        failures.push(`${sourcePath} -> ${specifier} 未允许使用共享 runtime`);
      }
      if (targetModule && targetModule !== sourceModule) {
        if (sourceModule) {
          graph.get(sourceModule)?.add(targetModule);
          if (!allowedModuleDependencies.get(sourceModule)?.includes(targetModule)) {
            failures.push(`${sourcePath} -> ${targetModule} 违反模块依赖允许表`);
          }
        }
        if (target !== resolve(sourceRoot, targetModule, "index.js")) {
          failures.push(`${sourcePath} -> ${specifier} 未使用模块公开入口`);
        }
        if (targetModule === "codex-protocol" && sourceModule !== "codex-client") {
          failures.push(`${sourcePath} -> ${specifier} 协议只能由 Codex Client 引用`);
        }
        if (targetModule === "codex-client" && sourceModule !== "bootstrap") {
          failures.push(`${sourcePath} -> ${specifier} 业务模块依赖具体 Codex Client`);
        }
      }
      const channels = ["feishu", "telegram", "weixin"];
      const sourceChannel = channels.find(channel => isInside(resolve(sourceRoot, "surfaces", channel), file));
      if (sourceChannel && channels.some(channel => channel !== sourceChannel
        && isInside(resolve(sourceRoot, "surfaces", channel), target))) {
        failures.push(`${sourcePath} -> ${specifier} 跨 Surface 渠道导入`);
      }
    }
  }
  const protocolEntry = readFileSync(resolve(sourceRoot, "codex-protocol/index.ts"), "utf8");
  for (const match of protocolEntry.matchAll(/^export (?:type \{ |const )([^ }=]+)/gmu)) {
    if (!importedProtocolNames.has(match[1])) failures.push(`codex-protocol 未使用的受控导出 ${match[1]}`);
  }
  const turnPort = readFileSync(resolve(sourceRoot, "application/turn-port.ts"), "utf8");
  if (turnPort.includes('type: "audio"') || !turnPort.includes('type: "localAudio"') || !turnPort.includes('type: "skill"')) {
    failures.push("application/turn-port.ts 超出支持的输入类型边界");
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      failures.push(`模块依赖循环：${[...stack.slice(stack.indexOf(name)), name].join(" -> ")}`);
      return;
    }
    visiting.add(name);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of moduleNames) visit(name);
}

function topLevelModule(file, moduleNames) {
  const [name] = relative(sourceRoot, file).split(/[\\/]/u);
  return moduleNames.has(name) ? name : undefined;
}

function isInside(directory, target) {
  const path = relative(directory, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

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
