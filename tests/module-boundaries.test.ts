import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve("src");

describe("module boundaries", () => {
  it("keeps core independent from routing and infrastructure implementations", () => {
    expect(violations("conversation-core", [
      "application",
      "bootstrap",
      "codex-client",
      "session-routing",
      "storage",
      "surfaces",
    ])).toEqual([]);
  });

  it("keeps the Codex client independent from application and surfaces", () => {
    expect(violations("codex-client", [
      "application",
      "approval",
      "bootstrap",
      "conversation-core",
      "policy",
      "session-routing",
      "storage",
      "surfaces",
    ])).toEqual([]);
  });

  it("prevents surfaces from bypassing the application boundary into the Codex client", () => {
    expect(violations("surfaces", ["codex-client"])).toEqual([]);
  });

  it("requires cross-module imports to use public entry points", () => {
    expect(publicEntryViolations()).toEqual([]);
  });
});

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

function violations(moduleName: string, forbiddenModules: string[]): string[] {
  const moduleRoot = resolve(sourceRoot, moduleName);
  const forbiddenRoots = forbiddenModules.map((name) => resolve(sourceRoot, name));
  const found: string[] = [];
  for (const file of typescriptFiles(moduleRoot)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = resolve(dirname(file), specifier);
      const forbidden = forbiddenRoots.find(
        (root) => isInside(root, target),
      );
      if (forbidden) {
        found.push(`${relative(sourceRoot, file)} -> ${relative(sourceRoot, target)}`);
      }
    }
  }
  return found;
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
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}
