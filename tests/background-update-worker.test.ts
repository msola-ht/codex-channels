import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const id = "b87a9f86-cd80-4e63-a578-c8c7d199742d";
  return {
    id,
    unitName: `codexc-update-${id}`,
    cgroup: "",
    job: {
      formatVersion: 1, id, createdAt: "2026-10-04T00:00:00.000Z",
      originalSourceDirectory: "/original", sourceCommit: "a".repeat(40), snapshotSha256: "b".repeat(64),
      installedDirectory: "/prefix/lib/node_modules/@hegenai/codexc", npmPrefix: "/prefix",
      nodeBinary: "/usr/bin/node", environment: { PATH: "/usr/bin" }, unitName: `codexc-update-${id}`,
    },
    active: id as string | undefined,
    receipt: { formatVersion: 1, id, updatedAt: "2026-10-04T00:00:00.000Z", status: "queued", stage: "queued" },
    deploy: vi.fn(), recover: vi.fn(), write: vi.fn(), release: vi.fn(), lock: vi.fn(),
  };
});

afterEach(() => { vi.unstubAllEnvs(); });

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: (path: string, ...args: unknown[]) => path === "/proc/self/cgroup"
    ? fixture.cgroup : Reflect.apply(original.readFileSync, original, [path, ...args]) };
});
vi.mock("../scripts/background-update-state.mjs", () => ({
  readUpdateJob: () => fixture.job,
  readUpdateReceipt: () => fixture.receipt,
  readActiveUpdate: () => fixture.active,
  writeUpdateReceipt: fixture.write,
  releaseUpdate: fixture.release,
  withUpdateLock: fixture.lock,
}));
vi.mock("../scripts/local-source-deployment.mjs", () => ({ deployLocalSource: fixture.deploy, recoverLocalSource: fixture.recover }));

import { assertBackgroundUpdateWorkerIdentity, runBackgroundUpdateWorker } from "../scripts/background-update-worker.mjs";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODEX_CONNECT_SERVICE_ROLE", "");
  fixture.active = fixture.id;
  fixture.receipt.status = "queued";
  fixture.receipt.stage = "queued";
  fixture.cgroup = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${fixture.unitName}.service\n`;
  fixture.lock.mockImplementation(async (_root: string, callback: () => Promise<unknown>) => callback());
  fixture.write.mockImplementation(() => undefined);
  fixture.release.mockImplementation(() => undefined);
  fixture.deploy.mockResolvedValue({ version: "0.160.0",  restoredServices: ["app-server", "gateway"] });
  fixture.recover.mockResolvedValue({  restoredServices: [], recovery: { status: "not-needed", restoredServices: [], errors: [] } });
});

describe("background update worker identity", () => {
  it("accepts only exact normal or rescue unit components", () => {
    for (const suffix of [".service", "-rescue.service"]) {
      expect(() => assertBackgroundUpdateWorkerIdentity(fixture.unitName, {}, "linux", `0::/user.slice/${fixture.unitName}${suffix}`, suffix === "-rescue.service")).not.toThrow();
    }
    for (const path of [`${fixture.unitName}.service-other`, `other-${fixture.unitName}.service`, `${fixture.unitName}.service.scope`, "codexc-gateway.service"]) {
      expect(() => assertBackgroundUpdateWorkerIdentity(fixture.unitName, {}, "linux", `0::/${path}`)).toThrow("独立 systemd");
    }
    expect(() => assertBackgroundUpdateWorkerIdentity(fixture.unitName, {}, "linux", `invalid:/${fixture.unitName}.service`)).toThrow();
    expect(() => assertBackgroundUpdateWorkerIdentity(fixture.unitName, {}, "linux", `0::/${fixture.unitName}-rescue.service`)).toThrow();
    expect(() => assertBackgroundUpdateWorkerIdentity(fixture.unitName, {}, "linux", `0::/${fixture.unitName}.service`, true)).toThrow();
  });

  it("rejects service-role inheritance and unsupported platforms", () => {
    const cgroup = `0::/${fixture.unitName}.service`;
    expect(() => assertBackgroundUpdateWorkerIdentity(fixture.unitName, { CODEX_CONNECT_SERVICE_ROLE: "gateway" }, "linux", cgroup)).toThrow("服务进程环境");
    expect(() => assertBackgroundUpdateWorkerIdentity(fixture.unitName, {}, "darwin", cgroup)).toThrow("Linux");
  });
});

describe.skipIf(process.platform !== "linux")("background update worker orchestration", () => {
  it("holds the shared lock, persists progress before continuing and releases a successful job", async () => {
    fixture.deploy.mockImplementation(async (context: { onProgress: (stage: string, details: { status: string }) => Promise<void> }) => {
      await context.onProgress("inspect-candidate", { status: "started" });
      expect(fixture.write).toHaveBeenLastCalledWith("/updates", fixture.id, expect.objectContaining({ status: "running", stage: "inspect-candidate" }));
      return { version: "0.160.0",  restoredServices: ["app-server", "gateway"] };
    });
    const receipt = await runBackgroundUpdateWorker("/updates", fixture.id);
    expect(receipt).toMatchObject({ status: "succeeded", stage: "complete", result: { version: "0.160.0" } });
    expect(fixture.lock).toHaveBeenCalledOnce();
    expect(fixture.deploy).toHaveBeenCalledWith(expect.objectContaining({ jobDirectory: `/updates/${fixture.id}`, sourceDirectory: `/updates/${fixture.id}/source`, runnerDirectory: `/updates/${fixture.id}/runner`, environment: fixture.job.environment }));
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledWith("/updates", fixture.id);
  });

  it("runs recovery after failure and releases only a proved safe recovery", async () => {
    fixture.deploy.mockRejectedValue(new Error("private upstream detail"));
    fixture.recover.mockResolvedValue({  restoredServices: ["gateway"], recovery: { status: "restored", restoredServices: ["gateway"], errors: [] } });
    const receipt = await runBackgroundUpdateWorker("/updates", fixture.id);
    expect(receipt.status).toBe("failed");
    expect(receipt.error).not.toContain("private upstream detail");
    expect(fixture.recover).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each(["failed", "stopped", "unknown"])("retains the reservation for an unsafe recovery result %s", async (status) => {
    fixture.deploy.mockRejectedValue(new Error("failure"));
    fixture.recover.mockResolvedValue({ recovery: { status } });
    expect((await runBackgroundUpdateWorker("/updates", fixture.id)).status).toBe("recovery-required");
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it("retains the reservation when recovery itself throws", async () => {
    fixture.deploy.mockRejectedValue(new Error("failure"));
    fixture.recover.mockRejectedValue(new Error("unsafe database combination"));
    expect((await runBackgroundUpdateWorker("/updates", fixture.id)).status).toBe("recovery-required");
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it("keeps private recovery exception details out of public status receipts", async () => {
    fixture.deploy.mockRejectedValue(new Error("failure"));
    fixture.recover.mockResolvedValue({ recovery: { status: "failed", restoredServices: [], errors: ["Authorization: private-secret"] } });
    const receipt = await runBackgroundUpdateWorker("/updates", fixture.id);
    expect(JSON.stringify(receipt)).not.toContain("private-secret");
    expect(receipt.status).toBe("recovery-required");
  });

  it.each(["queued", "running"])("rescues an interrupted %s task without repeating deployment", async (status) => {
    fixture.receipt.status = status;
    fixture.cgroup = `0::/user.slice/${fixture.unitName}-rescue.service`;
    expect((await runBackgroundUpdateWorker("/updates", fixture.id, { recover: true })).status).toBe("failed");
    expect(fixture.deploy).not.toHaveBeenCalled();
    expect(fixture.recover).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each(["succeeded", "failed"])("leaves terminal %s rescue tasks untouched", async (status) => {
    fixture.receipt.status = status;
    fixture.active = undefined;
    fixture.cgroup = `0::/user.slice/${fixture.unitName}-rescue.service`;
    expect(await runBackgroundUpdateWorker("/updates", fixture.id, { recover: true })).toBe(fixture.receipt);
    expect(fixture.deploy).not.toHaveBeenCalled();
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "failed"])("releases the same reservation after interruption between terminal %s receipt and release", async (status) => {
    fixture.receipt.status = status;
    fixture.cgroup = `0::/user.slice/${fixture.unitName}-rescue.service`;
    expect(await runBackgroundUpdateWorker("/updates", fixture.id, { recover: true })).toBe(fixture.receipt);
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith("/updates", fixture.id);
    expect(fixture.deploy).not.toHaveBeenCalled();
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it("does not release another task's reservation when rescuing a terminal receipt", async () => {
    fixture.receipt.status = "succeeded";
    fixture.active = "another-task";
    fixture.cgroup = `0::/user.slice/${fixture.unitName}-rescue.service`;
    expect(await runBackgroundUpdateWorker("/updates", fixture.id, { recover: true })).toBe(fixture.receipt);
    expect(fixture.release).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it("allows rescue for recovery-required tasks and rejects a duplicate normal deployment", async () => {
    fixture.receipt.status = "recovery-required";
    await expect(runBackgroundUpdateWorker("/updates", fixture.id)).rejects.toThrow("需要恢复");
    fixture.cgroup = `0::/user.slice/${fixture.unitName}-rescue.service`;
    expect((await runBackgroundUpdateWorker("/updates", fixture.id, { recover: true })).status).toBe("failed");
    expect(fixture.recover).toHaveBeenCalledOnce();
  });

  it("uses an engine-proved recovery without restarting services a second time", async () => {
    const error = Object.assign(new Error("failure"), { localDeploymentFailure: {
      stage: "build-candidate", recovery: { status: "not-needed", restoredServices: [], errors: [] },  errors: [],
    } });
    fixture.deploy.mockRejectedValue(error);
    expect((await runBackgroundUpdateWorker("/updates", fixture.id)).status).toBe("failed");
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("preserves a controlled version-mismatch diagnostic without exposing raw failure details", async () => {
    fixture.deploy.mockRejectedValue(Object.assign(new Error("Authorization: private-secret"), { localDeploymentFailure: {
      stage: "validate-candidate", summary: "Codex CLI 版本不匹配：需要 0.160.0，当前 0.159.0",
      recovery: { status: "not-needed", restoredServices: [], errors: [] },  errors: ["private-secret"],
    } }));
    const receipt = await runBackgroundUpdateWorker("/updates", fixture.id);
    expect(receipt.error).toContain("需要 0.160.0，当前 0.159.0");
    expect(JSON.stringify(receipt)).not.toContain("private-secret");
  });

  it("retains an engine-reported unsafe recovery without a second ordinary recovery attempt", async () => {
    fixture.deploy.mockRejectedValue(Object.assign(new Error("failure"), { localDeploymentFailure: {
      stage: "validate-databases", summary: "数据库版本尚未就绪；保持服务停止。",
      recovery: { status: "stopped", restoredServices: [], errors: [] },  errors: [],
    } }));
    expect((await runBackgroundUpdateWorker("/updates", fixture.id)).status).toBe("recovery-required");
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it("rejects a mismatched reservation and inherited Gateway role before deployment", async () => {
    fixture.active = "another-task";
    await expect(runBackgroundUpdateWorker("/updates", fixture.id)).rejects.toThrow("预约不匹配");
    expect(fixture.write).not.toHaveBeenCalled();
    fixture.active = fixture.id;
    vi.stubEnv("CODEX_CONNECT_SERVICE_ROLE", "gateway");
    await expect(runBackgroundUpdateWorker("/updates", fixture.id)).rejects.toThrow("服务进程环境");
    expect(fixture.deploy).not.toHaveBeenCalled();
  });

  it("aborts deployment on a progress receipt failure and enters recovery", async () => {
    fixture.write.mockImplementation((_root: string, _id: string, receipt: { stage: string }) => {
      if (receipt.stage === "stop-services") throw new Error("receipt unavailable");
    });
    fixture.deploy.mockImplementation(async (context: { onProgress: (stage: string, details: { status: string }) => Promise<void> }) => {
      await context.onProgress("stop-services", { status: "started" });
      throw new Error("must not reach live mutation");
    });
    await expect(runBackgroundUpdateWorker("/updates", fixture.id)).rejects.toThrow("receipt unavailable");
    expect(fixture.recover).toHaveBeenCalledOnce();
    expect(fixture.release).not.toHaveBeenCalled();
  });
});
