import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { enableManagement } from "../scripts/management-command.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("management command", () => {
  it("stores the credential below the configured user data directory", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-management-command-"));
    roots.push(home);
    let output = "";
    const result = enableManagement({ CODEX_CONNECT_HOME: home }, { write(value: string) { output += value; } } as NodeJS.WritableStream);
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(home, "management-credential"));
    expect(readFileSync(result.path, "utf8").trim()).toBe(result.credential);
    expect(output).toContain(result.credential!);
  });
});
