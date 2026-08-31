import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript protocol helper intentionally has no declaration file.
import { assertProtocolTreesEqual, generateProtocolTree, replaceProtocolTree } from "../scripts/protocol-schema.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("protocol schema scripts", () => {
  it("generates into a temporary directory without touching the current tree", () => {
    const root = temporaryDirectory();
    const current = join(root, "generated");
    mkdirSync(current);
    writeFileSync(join(current, "Current.ts"), "current\n");
    const codex = fakeCodex(root, false);

    const generated = generateProtocolTree(codex, root, root, { stdio: "ignore" });

    expect(readFileSync(join(current, "Current.ts"), "utf8")).toBe("current\n");
    expect(readFileSync(join(generated, "Generated.ts"), "utf8")).toBe("generated\n");
  });

  it("preserves the current tree when generation fails", () => {
    const root = temporaryDirectory();
    const current = join(root, "generated");
    mkdirSync(current);
    writeFileSync(join(current, "Current.ts"), "current\n");
    const codex = fakeCodex(root, true);

    expect(() => generateProtocolTree(codex, root, root, { stdio: "ignore" })).toThrow();
    expect(readFileSync(join(current, "Current.ts"), "utf8")).toBe("current\n");
    expect(readdirSync(root).some((entry) => entry.startsWith(".generated-"))).toBe(false);
  });

  it("compares and safely replaces complete generated trees", () => {
    const root = temporaryDirectory();
    const current = join(root, "current");
    const matching = join(root, "matching");
    const changed = join(root, "changed");
    for (const directory of [current, matching, changed]) {
      mkdirSync(directory);
    }
    writeFileSync(join(current, "Schema.ts"), "same\n");
    writeFileSync(join(matching, "Schema.ts"), "same\n");
    writeFileSync(join(changed, "Schema.ts"), "changed\n");

    expect(() => assertProtocolTreesEqual(current, matching)).not.toThrow();
    expect(() => assertProtocolTreesEqual(current, changed)).toThrow(
      "生成协议内容不一致：Schema.ts",
    );

    replaceProtocolTree(changed, current);
    expect(readFileSync(join(current, "Schema.ts"), "utf8")).toBe("changed\n");
    expect(existsSync(changed)).toBe(false);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-protocol-schema-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeCodex(root: string, fails: boolean): string {
  const path = join(root, `${fails ? "codex-fail" : "codex-success"}.cjs`);
  writeFileSync(path, [
    "#!/usr/bin/env node",
    "const { mkdirSync, writeFileSync } = require('node:fs');",
    fails
      ? "process.exit(7);"
      : [
          "const output = process.argv[process.argv.indexOf('--out') + 1];",
          "mkdirSync(output, { recursive: true });",
          "writeFileSync(`${output}/Generated.ts`, 'generated\\n');",
        ].join("\n"),
  ].join("\n"));
  if (process.platform !== "win32") chmodSync(path, 0o755);
  return path;
}
