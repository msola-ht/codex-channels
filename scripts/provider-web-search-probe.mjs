import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { loadManagedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import { loadConfiguredManagedProviderMaterial, readCodexConfigFile } from "../runtime/model-provider-managed-runtime.mjs";
import { loadConfiguredRelayProviderMaterial, loadOpenAiBaseUrl, managedProviderDirectory } from "../runtime/model-provider-runtime.mjs";
import { resolveClinePassRequestProfile } from "../runtime/chat-reasoning.mjs";
import { validateClinePassProviderOptions } from "../runtime/cline-provider-options.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import { readResponsesModelCatalog, isCustomCatalogProvider } from "../runtime/model-provider-responses-catalog.mjs";
import { readCustomProviderUpstreamWireApi } from "../runtime/model-provider-upstream-metadata.mjs";
import { validateCodexConfigDocument } from "../runtime/gateway-config.mjs";
import { resolveCodexRequestIdentity } from "../runtime/codex-request-identity.mjs";
import { probeNativeWebSearch } from "./custom-model-capability-probe.mjs";
import { loadProviderModelCatalogPresentations } from "./provider-model-management.mjs";
import { loadOpenAiModelCatalog } from "./webui-official-model-catalog.mjs";
import { locateOptionalUserConfig } from "./runtime-config.mjs";

const messages = {
  invalid_input: "原生搜索检测参数无效，请重新选择已配置的提供商与模型",
  stale_revision: "模型目录、账户或连接配置已变化，请刷新后重新检测；已发出的请求可能已计费",
  unavailable: "已配置的提供商或模型目录无法安全读取，未能完成检测",
  credential_unavailable: "当前官方认证无法用于独立诊断；仅支持文件存储的 API Key 或 ChatGPT 登录，诊断不读取系统钥匙串、不刷新登录",
};

export class ProviderWebSearchProbeError extends Error {
  constructor(code) {
    super(messages[code]);
    this.name = "ProviderWebSearchProbeError";
    this.code = code;
    this.statusCode = code === "invalid_input" ? 400 : code === "stale_revision" ? 409 : 503;
  }
}

/** 只解析当前登记身份，不接受 URL、Key、上游协议或能力写入。 */
export async function probeConfiguredProviderWebSearch(input, {environment = process.env, signal, timeoutMs = 45000} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["provider", "model", "revision"].includes(key))
    || typeof input.provider !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(input.provider)
    || typeof input.model !== "string" || !input.model.trim() || input.model.length > 200 || /\p{Cc}/u.test(input.model)
    || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000) throw new ProviderWebSearchProbeError("invalid_input");
  const controller = new AbortController();
  const abort = () => controller.abort();
  const deadline = performance.now() + timeoutMs;
  signal?.addEventListener("abort", abort, {once: true});
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const active = () => {
    if (controller.signal.aborted || performance.now() >= deadline) throw new ProviderWebSearchProbeError("unavailable");
  };
  const resolve = async () => {
    active();
    const material = await resolveMaterial(input, environment);
    const headers = configuredHeaders(environment);
    material.connection.requestContext.headers = {...material.connection.requestContext.headers, ...headers};
    material.fingerprint = fingerprint([material.fingerprint, headers]);
    active();
    return material;
  };
  try {
    const material = await resolve();
    if ((await resolve()).fingerprint !== material.fingerprint) throw new ProviderWebSearchProbeError("stale_revision");
    const result = await probeNativeWebSearch({...material.connection, model: input.model, environment,
      signal: controller.signal, timeoutMs: Math.max(1, Math.floor(deadline - performance.now()))});
    if (controller.signal.aborted) return {...result, provider: input.provider, status: signal?.aborted ? "cancelled" : "completed",
      check: {capability: "webSearch", status: "inconclusive", reason: signal?.aborted ? "模型能力检测已取消" : "模型能力检测总预算已耗尽"}};
    if ((await resolve()).fingerprint !== material.fingerprint) throw new ProviderWebSearchProbeError("stale_revision");
    return {...result, provider: input.provider};
  } catch (error) {
    if (error instanceof ProviderWebSearchProbeError) throw error;
    throw new ProviderWebSearchProbeError("unavailable");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function resolveMaterial(input, environment) {
  if (input.provider === "openai") return resolveOfficialMaterial(input, environment);
  const {catalogs} = await loadProviderModelCatalogPresentations({environment});
  const catalog = catalogs.find(entry => entry.providers.includes(input.provider));
  if (!catalog) throw new ProviderWebSearchProbeError("invalid_input");
  if (catalog.revision !== input.revision) throw new ProviderWebSearchProbeError("stale_revision");
  const model = catalog.models.find(entry => entry.id === input.model);
  if (!model) throw new ProviderWebSearchProbeError("invalid_input");
  const definition = loadManagedModelProviderDefinitions(environment).find(entry => entry.id === input.provider);
  // CLP Codex 启用名单与 Relay 的独立转发目录不同，必须读取前者。
  const material = definition ? loadConfiguredManagedProviderMaterial(input.provider, environment)
    : loadConfiguredRelayProviderMaterial(input.provider, environment);
  if (!material.models.includes(input.model)) throw new ProviderWebSearchProbeError("stale_revision");
  const clinePass = definition?.upstreamWireApi === "chat_completions";
  let clineRequestProfile;
  let clineProviderOptions;
  if (clinePass) {
    const document = JSON.parse(readPrivateFileSync(join(managedProviderDirectory(environment, definition), definition.catalogFileName), 2_097_152));
    const entry = document.models.find(entry => entry.slug === input.model);
    if (!entry) throw new ProviderWebSearchProbeError("stale_revision");
    clineRequestProfile = resolveClinePassRequestProfile(entry.slug, entry.cline_request_profile);
    clineProviderOptions = validateClinePassProviderOptions(entry.cline_provider_options);
  }
  const upstreamWireApi = definition ? definition.upstreamWireApi ?? "responses"
    : isCustomCatalogProvider(input.provider) ? readCustomProviderUpstreamWireApi(environment, input.provider) : "responses";
  const sampling = isCustomCatalogProvider(input.provider)
    ? readResponsesModelCatalog(environment, input.provider).definitions.find(entry => entry.id === input.model)?.sampling : undefined;
  const connection = {baseUrl: material.baseUrl, apiKey: material.apiKey, upstreamWireApi,
    reasoningEffort: model.presentation.defaultReasoningEffort ?? (isCustomCatalogProvider(input.provider) ? "none" : null),
    requestContext: {clinePass, ...(clinePass ? {reasoningEfforts: model.presentation.reasoningEfforts, clineRequestProfile,
      ...(clineProviderOptions === undefined ? {} : {clineProviderOptions})} : {}), ...(sampling ? {sampling} : {})}};
  return {connection, fingerprint: fingerprint([input.provider, catalog.revision, material.revision, connection])};
}

async function resolveOfficialMaterial(input, environment) {
  const catalog = await loadOpenAiModelCatalog(environment);
  if (catalog.revision !== input.revision) throw new ProviderWebSearchProbeError("stale_revision");
  if (!catalog.models.some(model => model.model === input.model)) throw new ProviderWebSearchProbeError("invalid_input");
  let config;
  try { config = parse(readCodexConfigFile(join(codexHomePath(environment), "config.toml"))); }
  catch (error) { if (error?.code === "ENOENT") config = {}; else throw new ProviderWebSearchProbeError("unavailable"); }
  // 不从其他存储模式回退到可能过期的 auth.json，也不代替官方认证刷新。
  if (config.cli_auth_credentials_store !== undefined && config.cli_auth_credentials_store !== "file"
    || config.model_providers?.openai !== undefined || config.forced_login_method !== undefined
    || config.allowed_login_methods !== undefined || config.forced_chatgpt_workspace_id !== undefined
    || environment.CODEX_ACCESS_TOKEN || environment.CODEX_API_KEY) throw new ProviderWebSearchProbeError("credential_unavailable");
  let auth;
  try { auth = JSON.parse(readPrivateFileSync(join(codexHomePath(environment), "auth.json"), 128 * 1024)); }
  catch { throw new ProviderWebSearchProbeError("credential_unavailable"); }
  const mode = auth?.auth_mode ?? (auth?.OPENAI_API_KEY != null ? "apikey" : "chatgpt");
  const chatgpt = mode === "chatgpt";
  if (mode !== "apikey" && !chatgpt) throw new ProviderWebSearchProbeError("credential_unavailable");
  const apiKey = chatgpt ? auth?.tokens?.access_token : auth?.OPENAI_API_KEY;
  if (!validCredential(apiKey) || chatgpt && !validCredential(auth?.tokens?.account_id)) throw new ProviderWebSearchProbeError("credential_unavailable");
  const headers = chatgpt ? {"chatgpt-account-id": auth.tokens.account_id, originator: "codex_cli_rs"} : {};
  if (chatgpt) {
    // 身份令牌仅用于读取官方已存储的路由声明，不作为模型能力或有效认证的证明。
    let claims;
    try { claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString("utf8")); }
    catch { throw new ProviderWebSearchProbeError("credential_unavailable"); }
    if (claims?.["https://api.openai.com/auth"]?.chatgpt_account_is_fedramp === true) headers["x-openai-fedramp"] = "true";
  }
  const baseUrl = loadOpenAiBaseUrl(environment) ?? (chatgpt ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1");
  // models_cache 的 identity 是不透明路由哈希；它仅提供所选 ID，不拿其能力或思考默认值冒充官方声明。
  const connection = {baseUrl, apiKey, upstreamWireApi: "responses", reasoningEffort: null, requestContext: {chatgpt, headers}};
  return {connection, fingerprint: fingerprint([catalog.revision, catalog.scope, config, auth, connection])};
}

function validCredential(value) { return typeof value === "string" && value.length > 0 && value.length <= 4096 && value.trim() === value && !/\p{Cc}/u.test(value); }
function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function configuredHeaders(environment) {
  const located = locateOptionalUserConfig(environment);
  const document = located ? parse(readPrivateFileSync(located.configPath, 1024 * 1024)) : {};
  const codex = validateCodexConfigDocument(document.codex ?? {});
  const {upstreamUserAgent, clientIdentity} = resolveCodexRequestIdentity(codex);
  validateCodexConfigDocument({upstream_user_agent: upstreamUserAgent});
  return {...(upstreamUserAgent ? {"user-agent": upstreamUserAgent} : {}), ...(clientIdentity ? {originator: clientIdentity.name} : {})};
}
