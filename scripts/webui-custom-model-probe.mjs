import { parse } from "smol-toml";
import { join } from "node:path";
import { z } from "zod";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { readCodexConfigFile } from "../runtime/model-provider-managed-runtime.mjs";
import {
  listCustomPrimaryProviderCandidates,
  loadConfiguredCustomSwitchingModelProviders,
  readCustomPrimaryProviderApiKey,
  readPrimaryProviderBackup,
  validateCustomPrimaryModelProviderId,
  isValidCustomProviderApiKey,
} from "../runtime/model-provider-runtime.mjs";
import { customModelProbeConnection, customPrimaryProviderUrlsShareOrigin, validCustomPrimaryProviderBaseUrl } from "./custom-primary-provider-management.mjs";
import { probeCustomModelCapabilities } from "./custom-model-capability-probe.mjs";
import { probeConfiguredProviderWebSearch, ProviderWebSearchProbeError } from "./provider-web-search-probe.mjs";
import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";

const text = (maximum) => z.string().trim().min(1).max(maximum).refine(value => !/\p{Cc}/u.test(value));
const inputSchema = z.strictObject({
  providerId: text(64).optional(),
  baseUrl: text(2048),
  model: text(200),
  upstreamWireApi: z.enum(["responses", "chat_completions"]),
  capability: z.enum(["applyPatch", "toolSearch", "webSearch"]),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  credential: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("preserve") }),
    z.strictObject({ action: z.literal("replace"), apiKey: z.string().trim().refine(isValidCustomProviderApiKey) }),
  ]),
});
// One bounded operation per WebUI instance; management already owns rate limiting.
const active = new WeakSet();
const configuredInputSchema = z.strictObject({
  provider: text(64), model: text(200), revision: z.string().regex(/^[a-f0-9]{64}$/u),
});

export async function routeCustomModelCapabilityProbe({ environment, maximumBodyBytes, path, request, response, state }) {
  const configured = path === "/provider-settings/web-search-probe";
  if ((!configured && path !== "/provider-settings/probe") || request.method !== "POST") return false;
  const parsed = (configured ? configuredInputSchema : inputSchema).safeParse(await readJsonBody(request, Math.min(maximumBodyBytes, 16_384)));
  if (!parsed.success || new URL(request.url, "http://localhost").search) {
    throw new ApiError(400, "invalid_custom_model_probe", "能力检测请求字段无效");
  }
  if (active.has(state)) throw new ApiError(409, "custom_model_probe_busy", "已有模型能力检测正在进行");
  const controller = new AbortController();
  const disconnect = () => { if (!response.writableEnded) controller.abort(); };
  active.add(state);
  request.once("aborted", disconnect);
  response.once("close", disconnect);
  try {
    if (request.aborted || response.destroyed) controller.abort();
    if (controller.signal.aborted) return true;
    if (configured) {
      let result;
      try {
        result = await probeConfiguredProviderWebSearch(parsed.data, { environment, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return true;
        if (error instanceof ProviderWebSearchProbeError) {
          const code = error.code === "stale_revision" ? "provider_models_stale_revision"
            : error.code === "invalid_input" ? "provider_models_invalid_input"
            : error.code === "credential_unavailable" ? "provider_web_search_credential_unavailable" : "provider_models_unavailable";
          throw new ApiError(error.statusCode, code, error.message);
        }
        throw new ApiError(503, "custom_model_probe_failed", "模型能力检测未完成，请检查连接与凭据");
      }
      if (!response.destroyed && !controller.signal.aborted) sendManagementJson(response, 200, result);
      return true;
    }
    const input = parsed.data;
    let baseUrl;
    try { baseUrl = validCustomPrimaryProviderBaseUrl(input.baseUrl); }
    catch { throw new ApiError(400, "invalid_custom_model_probe", "能力检测地址无效"); }
    const apiKey = input.credential.action === "replace"
      ? input.credential.apiKey
      : resolvePreservedKey(input.providerId, baseUrl, environment);
    if (request.aborted || response.destroyed) controller.abort();
    if (controller.signal.aborted) return true;
    let result;
    try {
      result = await probeCustomModelCapabilities({ baseUrl, apiKey, model: input.model,
        upstreamWireApi: input.upstreamWireApi, capability: input.capability, reasoningEffort: input.reasoningEffort,
        environment, signal: controller.signal, timeoutMs: 45_000 });
    } catch {
      throw new ApiError(503, "custom_model_probe_failed", "模型能力检测未完成，请检查连接与凭据");
    }
    if (!response.destroyed && !controller.signal.aborted) sendManagementJson(response, 200, {
      ...result,
      ...(input.capability === "webSearch" ? {} : {
        connectionToken: customModelProbeConnection({ baseUrl, apiKey, model: input.model, upstreamWireApi: input.upstreamWireApi, reasoningEffort: input.reasoningEffort, capability: input.capability }),
      }),
    });
    return true;
  } finally {
    controller.abort();
    request.off("aborted", disconnect);
    response.off("close", disconnect);
    active.delete(state);
  }
}

function resolvePreservedKey(providerId, baseUrl, environment) {
  if (typeof providerId !== "string" || !providerId.startsWith("cp-")
    || validateCustomPrimaryModelProviderId(providerId, environment) !== null) {
    throw new ApiError(400, "custom_model_probe_credential_required", "请填写检测使用的 API Key");
  }
  try {
    const switching = loadConfiguredCustomSwitchingModelProviders(environment, providerId)[0];
    let block;
    if (switching !== undefined) {
      block = { base_url: switching.baseUrl, wire_api: "responses", experimental_bearer_token: switching.apiKey };
    } else {
      let config = {};
      try { config = parse(readCodexConfigFile(join(codexHomePath(environment), "config.toml"))); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      const providers = config.model_providers ?? {};
      block = listCustomPrimaryProviderCandidates(providers, environment).includes(providerId)
        ? providers[providerId] : readPrimaryProviderBackup(environment)[providerId];
    }
    // Retained credentials remain bound to the stored origin, including backups.
    if (!block || block.wire_api !== "responses" || typeof block.base_url !== "string"
      || !customPrimaryProviderUrlsShareOrigin(block.base_url, baseUrl)) {
      throw new ApiError(400, "custom_model_probe_credential_required", "地址 Origin 已变化或缺少凭据，请填写检测使用的 API Key");
    }
    const apiKey = readCustomPrimaryProviderApiKey(providerId, block, environment);
    if (typeof apiKey !== "string" || apiKey === "") throw new Error("Missing credential");
    return apiKey;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "custom_model_probe_credential_required", "已有凭据无法安全使用，请填写检测使用的 API Key");
  }
}
