export class ManagementSecurityError extends Error {
  readonly code: string;
  readonly status: number;
}

export class ManagementAccessController {
  constructor(options: {
    credential: string;
    origin: string;
    now?: () => number;
    randomBytesImpl?: (length: number) => Buffer;
    absoluteTtlMs?: number;
    idleTtlMs?: number;
    attemptWindowMs?: number;
    maximumAttempts?: number;
  });
  login(input: { credential: string; origin: string; source: string }): {
    sessionId: string;
    sessionToken: string;
    csrfToken: string;
    expiresAt: number;
  };
  authorize(input: {
    sessionToken: string;
    csrfToken?: string;
    origin: string;
    method?: string;
  }): { sessionId: string; expiresAt: number };
  logout(sessionToken: string): boolean;
  revokeAll(): void;
}

export class ManagementRateLimiter {
  constructor(options?: { now?: () => number; windowMs?: number });
  consume(input: { sessionId: string; category: "read" | "write" | "high-risk" }): {
    remaining: number;
  };
}

export function provisionManagementCredential(
  path: string,
  options?: { rotate?: boolean; randomBytesImpl?: (length: number) => Buffer },
): { path: string; created: boolean; rotated: boolean; credential: string | null };
export function readManagementCredential(path: string): string;
export function managementSecurityHeaders(): Record<string, string>;
export function managementSessionCookie(token: string, options?: { secure?: boolean }): string;
export function clearManagementSessionCookie(options?: { secure?: boolean }): string;

export function validateManagementJsonRequest(input: {
  method: string;
  origin: string;
  expectedOrigin: string;
  contentType?: string;
  contentLength?: number;
  requestLineBytes?: number;
  headerBytes?: number;
}): { maximumBodyBytes: number };

export class ManagementConfirmationStore {
  constructor(options?: { now?: () => number; randomBytesImpl?: (length: number) => Buffer });
  issue(input: {
    sessionId: string;
    operation: string;
    inputFingerprint: string;
    resourceRevision: string;
    previewFingerprint: string;
    ttlMs?: number;
  }): { token: string; expiresAt: number };
  consume(token: string, binding: {
    sessionId: string;
    operation: string;
    inputFingerprint: string;
    resourceRevision: string;
    previewFingerprint: string;
  }): { operation: string; consumedAt: number };
  revokeSession(sessionId: string): void;
}

export function fingerprintManagementValue(value: unknown): string;

export class ManagementAuditWriter {
  constructor(path: string, options?: { now?: () => Date });
  record(event: {
    sessionId: string;
    source: string;
    operation: string;
    target?: string | null;
    inputFingerprint: string;
    previewId?: string | null;
    confirmationId?: string | null;
    revision?: string | null;
    phase: string;
    resultCode: string;
    recovery: string;
  }): { path: string; rotated: boolean; eventVersion: 1 };
  clear(): void;
}
