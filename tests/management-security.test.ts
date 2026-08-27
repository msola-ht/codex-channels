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
  managementSessionCookie,
  ManagementAccessController,
  ManagementAuditWriter,
  ManagementConfirmationStore,
  ManagementRateLimiter,
  provisionManagementCredential,
  readManagementCredential,
  validateManagementJsonRequest,
} from "../scripts/management-security.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("management security core", () => {
  it("binds short-lived sessions to an exact Origin and CSRF token", () => {
    let now = 1_000;
    let fill = 1;
    const access = new ManagementAccessController({
      credential: "management-secret",
      origin: "http://127.0.0.1:8787",
      now: () => now,
      randomBytesImpl: (length) => Buffer.alloc(length, fill++),
      absoluteTtlMs: 1_000,
      idleTtlMs: 500,
    });
    const session = access.login({
      credential: "management-secret",
      origin: "http://127.0.0.1:8787",
      source: "loopback",
    });

    expect(access.authorize({
      sessionToken: session.sessionToken,
      csrfToken: session.csrfToken,
      origin: "http://127.0.0.1:8787",
      method: "POST",
    })).toMatchObject({ sessionId: session.sessionId });
    expect(() => access.authorize({
      sessionToken: session.sessionToken,
      csrfToken: "wrong",
      origin: "http://127.0.0.1:8787",
      method: "POST",
    })).toThrow(expect.objectContaining({ code: "management.csrf-invalid" }));
    expect(() => access.authorize({
      sessionToken: session.sessionToken,
      origin: "http://localhost:8787",
      method: "GET",
    })).toThrow(expect.objectContaining({ code: "management.origin-invalid" }));
    now = 2_001;
    expect(() => access.authorize({
      sessionToken: session.sessionToken,
      origin: "http://127.0.0.1:8787",
      method: "GET",
    })).toThrow(expect.objectContaining({ code: "management.session-invalid" }));
  });

  it("rate limits repeated authentication failures per source", () => {
    const access = new ManagementAccessController({
      credential: "management-secret",
      origin: "http://127.0.0.1:8787",
      maximumAttempts: 2,
    });
    const attempt = () => access.login({
      credential: "wrong",
      origin: "http://127.0.0.1:8787",
      source: "loopback",
    });

    expect(attempt).toThrow(expect.objectContaining({ code: "management.authentication-failed" }));
    expect(attempt).toThrow(expect.objectContaining({ code: "management.authentication-failed" }));
    expect(attempt).toThrow(expect.objectContaining({ code: "management.rate-limited" }));
  });

  it("provisions a private 256-bit credential and only replaces it explicitly", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-management-credential-"));
    roots.push(root);
    const path = join(root, "credential");
    let fill = 1;
    const randomBytesImpl = (length: number) => Buffer.alloc(length, fill++);

    const created = provisionManagementCredential(path, { randomBytesImpl });
    expect(created).toMatchObject({ created: true, rotated: false });
    expect(created.credential).toHaveLength(43);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readManagementCredential(path)).toBe(created.credential);
    expect(provisionManagementCredential(path, { randomBytesImpl })).toEqual({
      path,
      created: false,
      rotated: false,
      credential: null,
    });
    const rotated = provisionManagementCredential(path, { rotate: true, randomBytesImpl });
    expect(rotated).toMatchObject({ created: false, rotated: true });
    expect(rotated.credential).not.toBe(created.credential);
  });

  it("provides shared response headers, session cookies and category limits", () => {
    expect(managementSecurityHeaders()).toMatchObject({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    expect(managementSessionCookie("session_token", { secure: true }))
      .toContain("HttpOnly; SameSite=Strict; Max-Age=1800; Secure");
    const limiter = new ManagementRateLimiter();
    for (let index = 0; index < 5; index += 1) {
      limiter.consume({ sessionId: "session-a", category: "high-risk" });
    }
    expect(() => limiter.consume({ sessionId: "session-a", category: "high-risk" }))
      .toThrow(expect.objectContaining({ code: "management.rate-limited" }));
    expect(limiter.consume({ sessionId: "session-a", category: "read" }).remaining).toBe(119);
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
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
