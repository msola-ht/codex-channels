import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve("src");

const allowedModuleDependencies: Record<string, readonly string[]> = {
  application: [
    "codex-client",
    "codex-protocol",
    "conversation-core",
    "policy",
    "session-routing",
  ],
  approval: [
    "codex-client",
    "codex-protocol",
    "conversation-core",
    "session-routing",
  ],
  bootstrap: [
    "application",
    "approval",
    "codex-client",
    "codex-protocol",
    "config",
    "conversation-core",
    "event-bus",
    "observability",
    "policy",
    "session-routing",
    "storage",
    "surfaces",
  ],
  "codex-client": ["application", "codex-protocol", "session-routing"],
  "codex-protocol": [],
  config: [],
  "conversation-core": ["codex-protocol", "event-bus"],
  "event-bus": [],
  observability: ["config"],
  policy: ["conversation-core"],
  "session-routing": [
    "conversation-core",
    "policy",
    "storage",
  ],
  storage: ["conversation-core"],
  surfaces: [
    "application",
    "approval",
    "codex-protocol",
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

  it("prevents production source from depending on CLI and project scripts", () => {
    expect(externalDirectoryViolations(["bin", "scripts", "tests"])).toEqual([]);
  });

  it("requires cross-module imports to use public entry points", () => {
    expect(publicEntryViolations()).toEqual([]);
  });
});

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
