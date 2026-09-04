import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  fingerprintManagementValue,
  managementSecurityHeaders,
  ManagementAuditWriter,
  ManagementConfirmationStore,
  ManagementRateLimiter,
  validateManagementJsonRequest,
} from "../scripts/management-security.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("management security core", () => {
  it("provides shared response headers and category limits", () => {
    expect(managementSecurityHeaders()).toMatchObject({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    const limiter = new ManagementRateLimiter();
    for (let index = 0; index < 5; index += 1) {
      limiter.consume({ principalId: "principal-a", category: "high-risk" });
    }
    expect(() => limiter.consume({ principalId: "principal-a", category: "high-risk" }))
      .toThrow(expect.objectContaining({ code: "management.rate-limited" }));
    expect(limiter.consume({ principalId: "principal-a", category: "read" }).remaining).toBe(119);
  });

  it("consumes confirmations once and binds every preview field", () => {
    let now = 1_000;
    const confirmations = new ManagementConfirmationStore({
      now: () => now,
      randomBytesImpl: (length) => Buffer.alloc(length, 7),
    });
    const binding = {
      sessionId: "session-a",
      operation: "provider.remove",
      inputFingerprint: fingerprintManagementValue({ provider: "relay" }),
      resourceRevision: fingerprintManagementValue("revision-a"),
      previewFingerprint: fingerprintManagementValue({ removes: ["relay"] }),
    };
    const issued = confirmations.issue(binding);

    expect(confirmations.consume(issued.token, binding)).toEqual({
      operation: "provider.remove",
      consumedAt: now,
    });
    expect(() => confirmations.consume(issued.token, binding))
      .toThrow(expect.objectContaining({ code: "management.confirmation-invalid" }));

    now += 1;
    const replacement = confirmations.issue(binding);
    expect(() => confirmations.consume(replacement.token, {
      ...binding,
      resourceRevision: fingerprintManagementValue("revision-b"),
    })).toThrow(expect.objectContaining({ code: "management.confirmation-invalid" }));

    const malformed = confirmations.issue(binding);
    expect(() => confirmations.consume(malformed.token, null as never))
      .toThrow(expect.objectContaining({ code: "management.confirmation-invalid" }));
    expect(() => confirmations.consume(malformed.token, binding))
      .toThrow(expect.objectContaining({ code: "management.confirmation-invalid" }));
    expect(() => fingerprintManagementValue(Number.NaN)).toThrow("有限数字");
  });

  it("enforces exact JSON request metadata limits", () => {
    expect(validateManagementJsonRequest({
      method: "POST",
      origin: "http://127.0.0.1:8787",
      expectedOrigin: "http://127.0.0.1:8787",
      contentType: "application/json; charset=utf-8",
      contentLength: 1024,
    })).toEqual({ maximumBodyBytes: 65_536 });
    expect(() => validateManagementJsonRequest({
      method: "POST",
      origin: "http://127.0.0.1:8787",
      expectedOrigin: "http://127.0.0.1:8787",
      contentType: "text/plain",
      contentLength: 1,
    })).toThrow(expect.objectContaining({ code: "management.content-type-invalid" }));
    expect(() => validateManagementJsonRequest({
      method: "GET",
      origin: "http://127.0.0.1:8787",
      expectedOrigin: "http://127.0.0.1:8787",
      requestLineBytes: 8_193,
    })).toThrow(expect.objectContaining({ code: "management.request-line-too-large" }));
  });

  it("writes bounded private audit events without arbitrary request fields", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-management-audit-"));
    roots.push(root);
    const path = join(root, "audit.jsonl");
    const fingerprint = fingerprintManagementValue("known");
    const audit = new ManagementAuditWriter(path, {
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });

    audit.record({
      sessionId: fingerprint,
      source: "loopback",
      operation: "config.update",
      target: "display.reasoning",
      inputFingerprint: fingerprint,
      revision: fingerprint,
      phase: "completed",
      resultCode: "ok",
      recovery: "not-required",
      requestBody: "must-not-be-recorded",
    } as Parameters<ManagementAuditWriter["record"]>[0] & { requestBody: string });

    const content = readFileSync(path, "utf8");
    expect(content).toContain('"operation":"config.update"');
    expect(content).not.toContain("must-not-be-recorded");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
