import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DeliveryJournal } from "../src/surfaces/index.js";
import { cli, mkdtempSync, updateGatewayConfig } from "./codexc-cli-test-fixture.js";

it("provides redacted live status and refuses recovery or rollback without exclusive ownership and acknowledgement", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-cli-test-"));
  const data = join(root, "connect");
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const env = { ...process.env, CODEX_CONNECT_HOME: data, CODEX_CONNECT_CONFIG_FILE: "", CODEX_CONNECT_SERVICE_ROLE: "" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, cwd: workspace, encoding: "utf8", timeout: 10_000 });
  let journal: DeliveryJournal | undefined;
  try {
    expect(run("init").status).toBe(0);
    updateGatewayConfig(join(data, "config.toml"), document => {
      document.telegram = { bot_token: "123:fixture", allowed_user_ids: [1], message_format: "html" };
    });
    journal = new DeliveryJournal(join(data, "data", "delivery-v1"));
    journal.accept({ id: "message", stream: "input", lane: "private-chat", payload: "secret body", control: false });
    const id = journal.inspect()[0]!.id;
    const status = run("delivery", "status", "--json");
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).records).toHaveLength(1);
    expect(status.stdout).not.toContain("secret body");
    expect(status.stdout).not.toContain("private-chat");
    expect(run("delivery", "resolve", id, "--acknowledge").status).toBe(1);
    journal.close();
    expect(run("delivery", "check-rollback").status).toBe(1);
    expect(run("delivery", "resolve", id).status).toBe(1);
    expect(run("delivery", "resolve", id, "--acknowledge").status).toBe(0);
    expect(run("delivery", "check-rollback").status).toBe(0);
    for (const command of ["status", "resolve", "clear-fault", "check-rollback"]) {
      for (const help of ["-h", "--help"]) expect(run("delivery", command, help).status).toBe(0);
    }
  } finally { journal?.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
