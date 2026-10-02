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
  it("bounds account refreshes independently from settings writes", () => {
    let now = 1_000;
    const limiter = new ManagementRateLimiter({ now: () => now });
    for (let i = 0; i < 120; i += 1) limiter.consume({ principalId: "account-user", category: "account-refresh" });
    expect(() => limiter.consume({ principalId: "account-user", category: "account-refresh" }))
      .toThrow(expect.objectContaining({ code: "management.rate-limited" }));
    expect(limiter.consume({ principalId: "account-user", category: "write" }).remaining).toBe(59);
    now += 60_000;
    expect(limiter.consume({ principalId: "account-user", category: "account-refresh" }).remaining).toBe(119);
  });
  it("provides shared response headers and category limits", () => {
    expect(managementSecurityHeaders()).toMatchObject({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    const limiter = new ManagementRateLimiter();
    for (let index = 0; index < 30; index += 1) {
      limiter.consume({ principalId: "principal-a", category: "high-risk" });
    }
    expect(() => limiter.consume({ principalId: "principal-a", category: "high-risk" }))
      .toThrow(expect.objectContaining({ code: "management.rate-limited" }));
    expect(limiter.consume({ principalId: "principal-a", category: "read" }).remaining).toBe(119);
  });

  it("allows sixty writes and thirty high-risk operations with independent principals and window recovery", () => {
    let now = 1_000;
    const limiter = new ManagementRateLimiter({ now: () => now });
    for (let index = 0; index < 30; index++) {
      limiter.consume({ principalId: "user", category: "write" });
      limiter.consume({ principalId: "user", category: "write" });
      limiter.consume({ principalId: "user", category: "high-risk" });
    }
    for (const category of ["write", "high-risk"] as const) {
      expect(() => limiter.consume({ principalId: "user", category }))
        .toThrow(expect.objectContaining({ code: "management.rate-limited", status: 429 }));
      expect(() => limiter.consume({ principalId: "another-user", category })).not.toThrow();
    }
    now += 60_000;
    expect(limiter.consume({ principalId: "user", category: "write" }).remaining).toBe(59);
    expect(limiter.consume({ principalId: "user", category: "high-risk" }).remaining).toBe(29);
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
      resourceRevision: `sha256:${"a".repeat(64)}`,
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
      resourceRevision: `sha256:${"b".repeat(64)}`,
    })).toThrow(expect.objectContaining({ code: "management.confirmation-invalid" }));

    const malformed = confirmations.issue(binding);
    expect(() => confirmations.consume(malformed.token, null as never))
      .toThrow(expect.objectContaining({ code: "management.confirmation-invalid" }));
    expect(() => confirmations.consume(malformed.token, binding))
      .toThrow(expect.objectContaining({ code: "management.confirmation-invalid" }));
    expect(() => fingerprintManagementValue(Number.NaN)).toThrow("有限数字");
  });

  it("allows 2 MiB only for exact Provider POST paths", () => {
    const request={method:"POST",origin:"http://127.0.0.1:8787",expectedOrigin:"http://127.0.0.1:8787",contentType:"application/json",contentLength:2*1024*1024};
    for(const path of ["/provider-settings", "/provider-settings/preview"]) {
      expect(validateManagementJsonRequest({...request,path})).toEqual({maximumBodyBytes:2*1024*1024});
      expect(()=>validateManagementJsonRequest({...request,path,contentLength:request.contentLength+1})).toThrow(expect.objectContaining({code:"management.body-too-large"}));
      expect(()=>validateManagementJsonRequest({...request,path,method:"PUT"})).toThrow("正文过大");
    }
    for(const path of ["/provider-settings/other", "/provider-settings/preview/", "/tasks", "/account-settings"]) {
      expect(validateManagementJsonRequest({...request,path,contentLength:65536})).toEqual({maximumBodyBytes:65536});
      expect(()=>validateManagementJsonRequest({...request,path,contentLength:65537})).toThrow("正文过大");
    }
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
