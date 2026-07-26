const deviceAuthorizationUrl =
  "https://accounts.feishu.cn/oauth/v1/device_authorization";
const tokenUrl =
  "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const userInfoUrl =
  "https://open.feishu.cn/open-apis/authen/v1/user_info";
const maximumPollAttempts = 200;
const maximumPollIntervalSeconds = 60;
const maximumDeviceAuthorizationSeconds = 1_800;
const maximumScopeLength = 128;
const maximumScopeBytes = 8_192;
const maximumApplicationScopeEntries = 1_000;
const maximumUserScopes = 100;
const maximumAuthorizationScopes = maximumUserScopes + 1;
const maximumAuthorizationUrlLength = 2_048;
const maximumDeviceCodeLength = 4_096;
const maximumTokenLength = 16_384;
const maximumOpenIdLength = 256;
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface FeishuDeviceAuthorization {
  deviceCode: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
  scopes: readonly string[];
}

export interface FeishuDeviceToken {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  refreshExpiresInSeconds: number;
  scopes: readonly string[];
}

export type FeishuDevicePollResult =
  | { status: "authorized"; token: FeishuDeviceToken }
  | { status: "denied" | "expired" };

export interface FeishuOAuthApi {
  listGrantedUserScopes(signal: AbortSignal): Promise<readonly string[]>;
  requestDeviceAuthorization(
    scopes: readonly string[],
    signal: AbortSignal,
  ): Promise<FeishuDeviceAuthorization>;
  pollDeviceToken(
    authorization: FeishuDeviceAuthorization,
    signal: AbortSignal,
  ): Promise<FeishuDevicePollResult>;
  readAuthorizedUser(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<string>;
}

interface FeishuOAuthHttpClientDependencies {
  fetch: typeof fetch;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  listGrantedUserScopes(signal: AbortSignal): Promise<unknown>;
}

export class FeishuOAuthHttpClient implements FeishuOAuthApi {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly dependencies: FeishuOAuthHttpClientDependencies,
  ) {}

  async listGrantedUserScopes(
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    const response = await this.dependencies.listGrantedUserScopes(signal);
    const root = requireRecord(response);
    if (root.code !== 0) {
      throw new Error("无法读取飞书应用权限");
    }
    const data = requireRecord(root.data);
    const app = requireRecord(data.app);
    if (
      !Array.isArray(app.scopes)
      || app.scopes.length > maximumApplicationScopeEntries
    ) {
      throw new Error("飞书 OAuth 响应格式无效");
    }
    const scopes = [...new Set(app.scopes.flatMap((entry) => {
      const scope = optionalRecord(entry);
      if (!scope) {
        throw new Error("飞书 OAuth 响应格式无效");
      }
      const name = scopeName(scope.scope);
      const rawTokenTypes = scope.token_types;
      if (
        rawTokenTypes !== undefined
        && (
          !Array.isArray(rawTokenTypes)
          || !rawTokenTypes.every((value) => typeof value === "string")
        )
      ) {
        throw new Error("飞书 OAuth 响应格式无效");
      }
      const tokenTypes = rawTokenTypes;
      return name && (!tokenTypes || tokenTypes.includes("user"))
        ? [name]
        : [];
    }))].sort();
    validateScopes(scopes, maximumUserScopes);
    return scopes;
  }

  async requestDeviceAuthorization(
    scopes: readonly string[],
    signal: AbortSignal,
  ): Promise<FeishuDeviceAuthorization> {
    const requestedScopes = [...new Set([
      ...scopes,
      "offline_access",
    ])];
    validateScopes(requestedScopes, maximumAuthorizationScopes);
    const response = await this.dependencies.fetch(deviceAuthorizationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${
          Buffer.from(`${this.appId}:${this.appSecret}`).toString("base64")
        }`,
      },
      body: new URLSearchParams({
        client_id: this.appId,
        scope: requestedScopes.join(" "),
      }),
      signal: boundedSignal(signal),
    });
    const body = requireRecord(await readJson(response));
    if (!response.ok || optionalString(body.error)) {
      throw new Error("飞书用户授权初始化失败");
    }
    const verificationUriComplete = validateAuthorizationUrl(
      requireBoundedString(
        body.verification_uri_complete,
        maximumAuthorizationUrlLength,
      ),
    );
    return {
      deviceCode: requireBoundedString(
        body.device_code,
        maximumDeviceCodeLength,
      ),
      verificationUriComplete,
      expiresInSeconds: boundedPositiveInteger(
        body.expires_in,
        maximumDeviceAuthorizationSeconds,
        240,
      ),
      intervalSeconds: boundedPositiveInteger(
        body.interval,
        maximumPollIntervalSeconds,
        5,
      ),
      scopes: requestedScopes,
    };
  }

  async pollDeviceToken(
    authorization: FeishuDeviceAuthorization,
    signal: AbortSignal,
  ): Promise<FeishuDevicePollResult> {
    const expiresInSeconds = Math.min(
      Math.max(1, authorization.expiresInSeconds),
      maximumDeviceAuthorizationSeconds,
    );
    const deadline = Date.now() + expiresInSeconds * 1_000;
    let interval = Math.min(
      Math.max(1, authorization.intervalSeconds),
      maximumPollIntervalSeconds,
    );
    let attempts = 0;
    while (Date.now() < deadline && attempts < maximumPollAttempts) {
      attempts += 1;
      await this.dependencies.sleep(interval * 1_000, signal);
      if (signal.aborted) {
        return { status: "expired" };
      }
      let body: Record<string, unknown>;
      try {
        const response = await this.dependencies.fetch(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: authorization.deviceCode,
            client_id: this.appId,
            client_secret: this.appSecret,
          }),
          signal: boundedSignal(signal),
        });
        body = requireRecord(await readJson(response));
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          return { status: "expired" };
        }
        interval = Math.min(interval + 1, maximumPollIntervalSeconds);
        continue;
      }
      const error = optionalString(body.error);
      if (!error && optionalString(body.access_token)) {
        const accessToken = requireBoundedString(
          body.access_token,
          maximumTokenLength,
        );
        const refreshToken = optionalBoundedString(
          body.refresh_token,
          maximumTokenLength,
        ) ?? "";
        const expiresInSeconds = boundedPositiveInteger(
          body.expires_in,
          2_678_400,
          7_200,
        );
        const scopes = parseScopeString(body.scope);
        return {
          status: "authorized",
          token: {
            accessToken,
            refreshToken,
            expiresInSeconds,
            refreshExpiresInSeconds: refreshToken
              ? boundedPositiveInteger(
                  body.refresh_token_expires_in,
                  31_622_400,
                  604_800,
                )
              : expiresInSeconds,
            scopes,
          },
        };
      }
      if (error === "authorization_pending") {
        continue;
      }
      if (error === "slow_down") {
        interval = Math.min(interval + 5, maximumPollIntervalSeconds);
        continue;
      }
      if (error === "access_denied") {
        return { status: "denied" };
      }
      return { status: "expired" };
    }
    return { status: "expired" };
  }

  async readAuthorizedUser(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.dependencies.fetch(userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: boundedSignal(signal),
    });
    const body = requireRecord(await readJson(response));
    if (!response.ok || optionalNumber(body.code) !== 0) {
      throw new Error("飞书授权身份校验失败");
    }
    return requireBoundedString(
      requireRecord(body.data).open_id,
      maximumOpenIdLength,
    );
  }
}

export function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("飞书 OAuth 响应格式无效");
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) {
    throw new Error("飞书 OAuth 响应格式无效");
  }
  return record;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireNonEmptyString(value: unknown): string {
  const result = optionalString(value);
  if (!result) {
    throw new Error("飞书 OAuth 响应格式无效");
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function boundedPositiveInteger(
  value: unknown,
  maximum: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  return typeof value === "number"
      && Number.isSafeInteger(value)
      && value > 0
      && value <= maximum
    ? value
    : invalidResponse();
}

function requireBoundedString(value: unknown, maximumLength: number): string {
  const result = requireNonEmptyString(value);
  if (result.length > maximumLength) {
    return invalidResponse();
  }
  return result;
}

function optionalBoundedString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireBoundedString(value, maximumLength);
}

function scopeName(value: unknown): string | undefined {
  if (value === "") {
    return undefined;
  }
  const scope = optionalString(value);
  if (!scope || scope.length > maximumScopeLength || !scopePattern.test(scope)) {
    return invalidResponse();
  }
  return scope;
}

function parseScopeString(value: unknown): string[] {
  const raw = optionalString(value);
  if (!raw) {
    return [];
  }
  const scopes = [...new Set(raw.split(/\s+/u).filter(Boolean))];
  validateScopes(scopes, maximumAuthorizationScopes);
  return scopes;
}

function validateScopes(
  scopes: readonly string[],
  maximumScopes: number,
): void {
  if (
    scopes.length > maximumScopes
    || scopes.some((scope) =>
      scope.length > maximumScopeLength || !scopePattern.test(scope)
    )
    || Buffer.byteLength(scopes.join(" "), "utf8") > maximumScopeBytes
  ) {
    invalidResponse();
  }
}

function validateAuthorizationUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidResponse();
  }
  if (
    parsed.origin !== "https://accounts.feishu.cn"
    || parsed.username
    || parsed.password
  ) {
    return invalidResponse();
  }
  return parsed.toString();
}

function invalidResponse(): never {
  throw new Error("飞书 OAuth 响应格式无效");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function boundedSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(15_000),
  ]);
}
