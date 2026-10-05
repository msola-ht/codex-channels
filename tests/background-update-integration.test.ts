import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectBackgroundUpdate, submitBackgroundUpdate } from "../scripts/background-update.mjs";
import { readUpdateJob, updateRoot, withUpdateLock } from "../scripts/background-update-state.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe.skipIf(process.platform !== "linux")("background updater real persistence integration", () => {
  it("freezes dirty source, queues independent units, persists readable status, and shares its lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-update-integration-")); directories.push(directory);
    const source = join(directory, "source with spaces"); mkdirSync(source);
    const git = (args: string[]) => execFileSync("git", args, {cwd: source, stdio: "pipe"});
    git(["init"]);
    writeFileSync(join(source, "package.json"), JSON.stringify({name: "@hegenai/codexc", version: "0.160.0"}));
    git(["add", "package.json"]);
    git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
    writeFileSync(join(source, "dirty.txt"), "snapshot contents");
    const installed = join(directory, "prefix/lib/node_modules/@hegenai/codexc");
    mkdirSync(join(installed, "node_modules"), {recursive: true});
    writeFileSync(join(installed, "package.json"), JSON.stringify({name: "@hegenai/codexc"}));
    const home = join(directory, "home"); mkdirSync(home, {mode: 0o700});
    const config = join(home, "config.toml"); writeFileSync(config, "", {mode: 0o600});
    const environment = {CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: config};
    const calls: string[][] = [];
    const task = await submitBackgroundUpdate(source, environment, {
      packageDirectory: installed, systemd: args => { calls.push(args); return ""; },
    });
    writeFileSync(join(source, "dirty.txt"), "later change");
    expect(readFileSync(join(task.jobDirectory, "source/dirty.txt"), "utf8")).toBe("snapshot contents");
    const job = readUpdateJob(updateRoot(environment), task.id);
    expect(job.unitName).toBe(`codexc-update-${task.id}`);
    expect(calls[1]).toContain(`--unit=${job.unitName}-rescue`);
    expect(inspectBackgroundUpdate(task.id, environment, {systemd: () => "ActiveState=inactive"}).status).toBe("queued");
    await expect(submitBackgroundUpdate(source, environment, {packageDirectory: installed, systemd: () => ""})).rejects.toThrow("已有后台");
    await withUpdateLock(updateRoot(environment), async () => {
      await expect(withUpdateLock(updateRoot(environment), async () => undefined)).rejects.toThrow();
    });
  });
});
