import {
  chmodSync,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { resetMetricsDatabase } from "../scripts/metrics-database.mjs";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import {
  cleanupMetricsDatabaseTestFixtures,
  createMetricsDatabase,
  createMetricsDatabaseTestFixture,
} from "./metrics-database-test-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  cleanupMetricsDatabaseTestFixtures(temporaryDirectories);
});

function fixture() {
  return createMetricsDatabaseTestFixture(temporaryDirectories);
}

describe("model request metrics database reset", () => {
  it("refuses to reset while Gateway is running", () => {
    const { environment, databasePath } = fixture();
    createMetricsDatabase(databasePath, 1, 1);

    expect(() => resetMetricsDatabase(environment, {
      gatewayRunning: () => true,
    })).toThrow(/codexc service stop gateway/u);
    expect(existsSync(databasePath)).toBe(true);
  });

  it.runIf(process.platform === "linux")(
    "fails closed when systemd reports a failed Gateway service",
    () => {
      const { environment, databasePath, home } = fixture();
      createMetricsDatabase(databasePath, 1, 1);
      const systemctl = join(home, "systemctl");
      writeFileSync(systemctl, "#!/bin/sh\nprintf 'failed\\n'\n", { mode: 0o700 });
      chmodSync(systemctl, 0o700);

      expect(() => resetMetricsDatabase({
        ...environment,
        SYSTEMCTL_BINARY: systemctl,
      })).toThrow(/Gateway/u);
      expect(existsSync(databasePath)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "fails closed when the Gateway service state cannot be queried",
    () => {
      const { environment, databasePath, home } = fixture();
      createMetricsDatabase(databasePath, 1, 1);
      const systemctl = join(home, "systemctl");
      writeFileSync(systemctl, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      chmodSync(systemctl, 0o700);

      expect(() => resetMetricsDatabase({
        ...environment,
        SYSTEMCTL_BINARY: systemctl,
      })).toThrow(/无法确认 Gateway 服务状态/u);
      expect(existsSync(databasePath)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses to reset while a foreground Gateway metrics socket is active",
    async () => {
      const { environment, databasePath, home } = fixture();
      createMetricsDatabase(databasePath, 1, 1);
      const systemctl = join(home, "systemctl");
      writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\n", { mode: 0o700 });
      chmodSync(systemctl, 0o700);
      const socketPath = join(home, "runtime", "codex-app-server-openai-metrics.sock");
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      try {
        expect(() => resetMetricsDatabase({
          ...environment,
          SYSTEMCTL_BINARY: systemctl,
        })).toThrow(/Gateway/u);
        expect(existsSync(databasePath)).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "allows reset when only a stale metrics socket path remains",
    () => {
      const { environment, databasePath, home } = fixture();
      createMetricsDatabase(databasePath, 1, 1);
      const systemctl = join(home, "systemctl");
      writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\n", { mode: 0o700 });
      chmodSync(systemctl, 0o700);
      writeFileSync(
        join(home, "runtime", "codex-app-server-openai-metrics.sock"),
        "stale",
        { mode: 0o600 },
      );

      expect(resetMetricsDatabase({
        ...environment,
        SYSTEMCTL_BINARY: systemctl,
      }).changed).toBe(true);
    },
  );

  it("checkpoints, backs up and removes an offline database", () => {
    const { environment, databasePath } = fixture();
    createMetricsDatabase(databasePath, 1, 2);

    const result = resetMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-02T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      databasePath,
      previousSchemaVersion: 1,
    });
    expect(result.backupPath).toContain(".v1.2026-08-02T12-34-56-789Z.bak");
    expect(existsSync(result.backupPath!)).toBe(true);
    if (process.platform !== "win32") expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    expect(existsSync(databasePath)).toBe(false);
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT COUNT(*) AS count FROM model_request_metrics").get())
      .toEqual({ count: 2 });
    backup.close();
  });

  it("refuses to reset when an unmanaged Gateway still owns the metrics database", () => {
    const { environment, databasePath } = fixture();
    const active = new SqliteModelRequestMetricsStore(databasePath);

    expect(() => resetMetricsDatabase(environment, {
      gatewayRunning: () => false,
    })).toThrow(/正在使用/u);
    expect(existsSync(databasePath)).toBe(true);

    active.close();
    expect(resetMetricsDatabase(environment, {
      gatewayRunning: () => false,
    }).changed).toBe(true);
  });

  it("is idempotent when no metrics database exists", () => {
    const { environment, databasePath } = fixture();

    expect(resetMetricsDatabase(environment, {
      gatewayRunning: () => false,
    })).toEqual({
      backupPath: null,
      changed: false,
      databasePath,
      previousSchemaVersion: null,
    });
  });
});
