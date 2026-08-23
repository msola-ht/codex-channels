import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve("src");
const runtimeRoot = resolve("runtime");

const allowedModuleDependencies: Record<string, readonly string[]> = {
  application: [
    "conversation-core",
    "policy",
    "session-routing",
  ],
  approval: [
    "conversation-core",
    "session-routing",
  ],
  bootstrap: [
    "application",
    "approval",
    "codex-client",
    "config",
    "conversation-core",
    "event-bus",
    "observability",
    "policy",
    "provider-proxy",
    "session-routing",
    "storage",
    "surfaces",
  ],
  "codex-client": [
    "approval",
    "application",
    "codex-protocol",
    "conversation-core",
    "session-routing",
  ],
  "codex-protocol": [],
  config: [],
  "conversation-core": ["event-bus"],
  "event-bus": [],
  "provider-proxy": [],
  observability: ["config"],
  policy: ["conversation-core"],
  "scheduled-tasks": [],
  "session-routing": [
    "conversation-core",
    "policy",
    "storage",
  ],
  storage: ["conversation-core"],
  surfaces: [
    "application",
    "approval",
    "config",
    "conversation-core",
    "event-bus",
    "policy",
  ],
};

describe("module boundaries", () => {
  it("enforces the complete top-level module dependency allowlist", () => {
    expect(moduleDependencyViolations()).toEqual([]);
  });

  it("keeps the top-level module dependency graph acyclic", () => {
    expect(moduleDependencyCycles()).toEqual([]);
  });

  it("keeps built-in Surface channels isolated", () => {
    expect(surfaceChannelImportViolations()).toEqual([]);
  });

  it("keeps Surfaces behind the application use-case interface", () => {
    const concreteDependencies = typescriptFiles(
      resolve(sourceRoot, "surfaces"),
    ).flatMap((file) =>
      readFileSync(file, "utf8").includes("ConversationService")
        ? [relative(sourceRoot, file)]
        : []
    );
    expect(concreteDependencies).toEqual([]);
  });

  it("prevents production source from depending on CLI and project scripts", () => {
    expect(externalDirectoryViolations(["bin", "scripts", "tests"])).toEqual([]);
  });

  it("limits shared runtime imports to the composition and config modules", () => {
    expect(runtimeImportViolations()).toEqual([]);
  });

  it("requires cross-module imports to use public entry points", () => {
    expect(publicEntryViolations()).toEqual([]);
  });

  it("keeps generated protocol imports inside Codex Client", () => {
    expect(moduleImportersOutside("codex-protocol", [
      "codex-client",
      "codex-protocol",
    ])).toEqual([]);
  });

  it("keeps concrete Codex Client imports out of business modules", () => {
    expect(moduleImportersOutside("codex-client", [
      "bootstrap",
      "codex-client",
    ])).toEqual([]);
  });

  it("keeps controlled protocol exports limited to Client imports in use", () => {
    const protocolEntry = readFileSync(
      resolve(sourceRoot, "codex-protocol/index.ts"),
      "utf8",
    );
    const exported = new Set([
      ...[...protocolEntry.matchAll(/^export type \{ ([^ }]+)/gmu)]
        .map((match) => match[1]!),
      ...[...protocolEntry.matchAll(/^export const ([^ =]+)/gmu)]
        .map((match) => match[1]!),
    ]);
    const imported = new Set(
      typescriptFiles(resolve(sourceRoot, "codex-client")).flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(
          /import(?: type)?\s*\{([^}]*)\}\s*from "\.\.\/codex-protocol\/index\.js";/gsu,
        )].flatMap((match) =>
          match[1]!.split(",")
            .map((name) => name.trim().split(/\s+as\s+/u, 1)[0])
            .filter((name): name is string => Boolean(name)));
      }),
    );
    expect([...exported].filter((name) => !imported.has(name))).toEqual([]);
  });

  it("keeps realtime APIs outside business entry points", () => {
    const turnPort = readFileSync(
      resolve(sourceRoot, "application/turn-port.ts"),
      "utf8",
    );
    expect(turnPort).not.toContain('type: "audio"');
    expect(turnPort).toContain('type: "localAudio"');
    expect(turnPort).toContain('type: "skill"');

    const realtimeCallers = typescriptFiles(
      resolve(sourceRoot, "codex-client"),
    ).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes('"thread/realtime/')
        ? [relative(sourceRoot, file)]
        : [];
    });
    expect(realtimeCallers).toEqual([]);
  });

  it("keeps unsupported experimental and developing APIs outside production clients", () => {
    const unsupportedMethods = [
      "thread/search",
      "thread/searchOccurrences",
      "thread/items/list",
      "thread/rollback",
      "plugin/list",
      "plugin/search",
      "plugin/read",
      "plugin/skill/read",
      "plugin/share/save",
      "plugin/share/updateTargets",
      "plugin/share/list",
      "plugin/share/checkout",
      "plugin/share/delete",
      "plugin/install",
      "plugin/uninstall",
      "marketplace/add",
      "marketplace/remove",
      "marketplace/upgrade",
    ] as const;
    const callers = typescriptFiles(resolve(sourceRoot, "codex-client"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return unsupportedMethods.flatMap((method) =>
          source.includes(`"${method}"`)
            ? [`${relative(sourceRoot, file)}: ${method}`]
            : []);
      });

    expect(callers).toEqual([]);
  });
});

function moduleImportersOutside(
  targetModule: string,
  allowedSources: readonly string[],
): string[] {
  const moduleNames = new Set(
    readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  const found: string[] = [];
  for (const file of typescriptFiles(sourceRoot)) {
    const sourceModule = topLevelModule(file, moduleNames);
    if (!sourceModule || allowedSources.includes(sourceModule)) {
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const importedModule = topLevelModule(
        resolve(dirname(file), specifier),
        moduleNames,
      );
      if (importedModule === targetModule) {
        found.push(`${relative(sourceRoot, file)} -> ${targetModule}`);
      }
    }
  }
  return found;
}

function externalDirectoryViolations(forbiddenDirectories: string[]): string[] {
  const forbiddenRoots = forbiddenDirectories.map((name) => resolve(name));
  const found: string[] = [];
  for (const file of typescriptFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = resolve(dirname(file), specifier);
      const forbidden = forbiddenRoots.find((root) => isInside(root, target));
      if (forbidden) {
        found.push(`${relative(sourceRoot, file)} -> ${relative(sourceRoot, target)}`);
      }
    }
  }
  return found;
}

function runtimeImportViolations(): string[] {
  const allowedModules = new Set(["bootstrap", "config"]);
  const moduleNames = new Set(Object.keys(allowedModuleDependencies));
  const found: string[] = [];
  for (const file of typescriptFiles(sourceRoot)) {
    const sourceModule = topLevelModule(file, moduleNames);
    if (sourceModule && allowedModules.has(sourceModule)) {
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = resolve(dirname(file), specifier);
      if (isInside(runtimeRoot, target)) {
        found.push(`${relative(sourceRoot, file)} -> ${relative(sourceRoot, target)}`);
      }
    }
  }
  return found;
}

function publicEntryViolations(): string[] {
  const moduleNames = new Set(
    readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  const found: string[] = [];
  for (const file of typescriptFiles(sourceRoot)) {
    const sourceModule = topLevelModule(file, moduleNames);
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = resolve(dirname(file), specifier);
      const targetModule = topLevelModule(target, moduleNames);
      if (!targetModule || targetModule === sourceModule) {
        continue;
      }
      const publicEntry = resolve(sourceRoot, targetModule, "index.js");
      if (target !== publicEntry) {
        found.push(`${relative(sourceRoot, file)} -> ${relative(sourceRoot, target)}`);
      }
    }
  }
  return found;
}

function topLevelModule(path: string, moduleNames: Set<string>): string | undefined {
  const [name] = relative(sourceRoot, path).split("/");
  return name && moduleNames.has(name) ? name : undefined;
}

function moduleDependencyViolations(): string[] {
  const actualModules = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const declaredModules = Object.keys(allowedModuleDependencies).sort();
  const found = actualModules.flatMap((moduleName) =>
    Object.hasOwn(allowedModuleDependencies, moduleName)
      ? []
      : [`${moduleName} -> 未声明模块`]);
  for (const moduleName of declaredModules) {
    if (!actualModules.includes(moduleName)) {
      found.push(`${moduleName} -> 模块不存在`);
    }
    for (const dependency of allowedModuleDependencies[moduleName] ?? []) {
      if (!actualModules.includes(dependency)) {
        found.push(`${moduleName} -> 未知依赖 ${dependency}`);
      }
    }
  }
  const moduleNames = new Set(actualModules);
  const allowedByModule = new Map(
    Object.entries(allowedModuleDependencies)
      .map(([moduleName, dependencies]) => [moduleName, new Set(dependencies)]),
  );
  for (const file of typescriptFiles(sourceRoot)) {
    const sourceModule = topLevelModule(file, moduleNames);
    if (!sourceModule) {
      continue;
    }
    const allowed = allowedByModule.get(sourceModule);
    if (!allowed) {
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = resolve(dirname(file), specifier);
      const targetModule = topLevelModule(target, moduleNames);
      if (targetModule && targetModule !== sourceModule && !allowed.has(targetModule)) {
        found.push(`${relative(sourceRoot, file)} -> ${targetModule}`);
      }
    }
  }
  return found.sort();
}

function moduleDependencyCycles(): string[] {
  const graph = actualModuleDependencies();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const found = new Set<string>();

  const visit = (moduleName: string): void => {
    if (visited.has(moduleName)) {
      return;
    }
    if (visiting.has(moduleName)) {
      const cycleStart = stack.indexOf(moduleName);
      found.add([...stack.slice(cycleStart), moduleName].join(" -> "));
      return;
    }
    visiting.add(moduleName);
    stack.push(moduleName);
    for (const dependency of [...(graph.get(moduleName) ?? [])].sort()) {
      visit(dependency);
    }
    stack.pop();
    visiting.delete(moduleName);
    visited.add(moduleName);
  };

  for (const moduleName of [...graph.keys()].sort()) {
    visit(moduleName);
  }
  return [...found].sort();
}

function actualModuleDependencies(): Map<string, Set<string>> {
  const moduleNames = new Set(
    readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  const graph = new Map(
    [...moduleNames].map((moduleName) => [moduleName, new Set<string>()]),
  );
  for (const file of typescriptFiles(sourceRoot)) {
    const sourceModule = topLevelModule(file, moduleNames);
    if (!sourceModule) {
      continue;
    }
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const targetModule = topLevelModule(
        resolve(dirname(file), specifier),
        moduleNames,
      );
      if (targetModule && targetModule !== sourceModule) {
        graph.get(sourceModule)?.add(targetModule);
      }
    }
  }
  return graph;
}

function surfaceChannelImportViolations(): string[] {
  const channels = ["feishu", "telegram", "weixin"] as const;
  const channelRoots = new Map(
    channels.map((channel) => [channel, resolve(sourceRoot, "surfaces", channel)]),
  );
  const found: string[] = [];
  for (const channel of channels) {
    const root = channelRoots.get(channel)!;
    for (const file of typescriptFiles(root)) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith(".")) {
          continue;
        }
        const target = resolve(dirname(file), specifier);
        for (const [otherChannel, otherRoot] of channelRoots) {
          if (otherChannel !== channel && isInside(otherRoot, target)) {
            found.push(
              `${relative(sourceRoot, file)} -> surfaces/${otherChannel}`,
            );
          }
        }
      }
    }
  }
  return found.sort();
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return typescriptFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
  ]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}
