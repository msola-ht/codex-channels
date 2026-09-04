export class ManagementSecurityError extends Error {
  readonly code: string;
  readonly status: number;
}

export class ManagementRateLimiter {
  constructor(options?: { now?: () => number; windowMs?: number });
  consume(input: { principalId: string; category: "read" | "write" | "high-risk" }): {
    remaining: number;
  };
}

export function managementSecurityHeaders(): Record<string, string>;

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
