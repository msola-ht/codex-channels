import { join } from "node:path";
import { parse } from "smol-toml";
import { webuiLogger } from "./webui-logger.mjs";
import { codexHomePath, hasCodexAuthFile } from "../runtime/codex-home.mjs";
import { readOpenAiCredentialRefreshTime } from "../runtime/openai-credentials.mjs";
import { readCodexConfigFile } from "../runtime/model-provider-managed-runtime.mjs";
import { routeResetCredits } from "./webui-reset-credit-route.mjs";
import { loadDeepseekAccounts, deepseekProviderId } from "../runtime/deepseek-accounts.mjs";
import { loadCcgAccounts, ccgProviderId } from "../runtime/ccg-accounts.mjs";
import { isOllamaCloudAccountProvider, loadOllamaCloudAccounts, ollamaCloudProviderId } from "../runtime/ollama-cloud-accounts.mjs";
import { loadClinePassAccounts, clinePassProviderId } from "../runtime/cline-pass-accounts.mjs";
import {
  GatewayAccountRefreshError,
} from "../runtime/gateway-account-refresh.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountDisplayName,
  opencodeGoProviderId,
} from "../runtime/opencode-go-accounts.mjs";
import {
  normalizeAccountSettingsMutation,
  redactAccountSettingsResult,
  discoverAccountSettingsModels,
} from "./webui-account-settings-management.mjs";
import { ApiError, readJsonBody, sendJson, sendManagementJson } from "./webui-http.mjs";
import {
  invalidateProviderManagementSummary,
  loadProviderManagementSummary,
  managementOperationError,
  assertManagementAuditWritable,
  readManagementSnapshot,
} from "./webui-management-operations.mjs";
import {
  loadProviderSettingsResource,
  normalizeProviderSettingsMutation,
  redactProviderSettingsResult,
} from "./webui-provider-settings-management.mjs";
import { invalidateServiceStatusSummary } from "./webui-service-status.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";
import { routeCustomModelCapabilityProbe } from "./webui-custom-model-probe.mjs";
import { routeOfficialModelManagement } from "./webui-management-official-model-route.mjs";
import { routeModelBaseManagement } from "./webui-management-model-base-route.mjs";
import { loadProviderModelCatalogPresentations, loadProviderModelPrompts, ProviderModelManagementError } from "./provider-model-management.mjs";
import { loadProviderModelTemplateOptions } from "./provider-model-template-management.mjs";
import { loadProviderModelAdditionOptions, verifyProviderModelAddition } from "./provider-model-additions.mjs";
import { loadManagedProviderModelRequestOptions } from "./managed-provider-model-edit.mjs";

const activeTemplateOptionsReads = new WeakSet();

export async function routeProviderManagement({
  configPath,
  environment,
  maximumBodyBytes,
  readMetrics,
  path,
  principalId,
  request,
  response,
  state,
}) {
  if (path === "/provider-model-catalogs" && request.method === "GET") {
    if (new URL(request.url, "http://localhost").searchParams.size !== 0) {
      throw new ApiError(400, "provider_models_invalid_input", "模型目录读取不接受查询参数");
    }
    try {
      sendManagementJson(response, 200, await loadProviderModelCatalogPresentations({ environment }));
    } catch {
      throw new ApiError(503, "provider_models_unavailable", "本地模型目录暂不可用，请检查配置文件");
    }
    return true;
  }
  if (await routeOfficialModelManagement({ environment, maximumBodyBytes, path, principalId, request, response, state })) return true;
  if (await routeModelBaseManagement({ environment, maximumBodyBytes, path, principalId, request, response, state })) return true;
  if (path === "/provider-model-additions/verify" && request.method === "POST") {
    if (new URL(request.url, "http://localhost").search || state.snapshotReadsClosed) throw new ApiError(400, "provider_models_invalid_input", "模型验证请求不可用");
    const input = await readJsonBody(request, Math.min(maximumBodyBytes, 16_384));
    if (state.snapshotReadsClosed) throw new ApiError(503, "provider_models_unavailable", "管理服务正在关闭，未开始模型验证");
    if (!input || typeof input !== "object" || Array.isArray(input) || input.confirmPaid !== true
      || typeof input.provider !== "string" || !/^olc-[A-Za-z0-9_-]{1,61}$/u.test(input.provider)
      || typeof input.sourceToken !== "string" || !/^[a-f0-9]{64}$/u.test(input.sourceToken)
      || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision)) throw new ApiError(400, "provider_models_invalid_input", "请明确确认准确账户与候选修订");
    if (activeTemplateOptionsReads.has(state)) throw new ApiError(503, "provider_templates_busy", "已有模型候选操作正在进行");
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    activeTemplateOptionsReads.add(state);
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    let entry;
    try {
      if (request.aborted || response.destroyed) controller.abort();
      controller.signal.throwIfAborted();
      assertManagementAuditWritable(state.audit);
      const auditStatus = recordProviderAudit(state, { sessionId: principalId, operation: "provider-model.verify",
        target: input.provider, inputFingerprint: fingerprintManagementValue(input), resourceRevision: input.revision,
        safePreview: { model: input.model, reasoningEfforts: input.reasoningEfforts }, confirmationToken: input.sourceToken,
        phase: "requested", resultCode: "started" }, "模型验证尚未开始，审计记录失败");
      if (auditStatus !== "recorded") throw new ApiError(503, "management_audit_unavailable", "审计记录不可用，未开始模型验证");
      const task = verifyProviderModelAddition(input, { environment, signal: controller.signal });
      entry = { controller, settled: task.then(() => undefined, () => undefined) };
      state.snapshotReads.add(entry);
      const result = await task;
      const completedAuditStatus = recordProviderAudit(state, { sessionId: principalId, operation: "provider-model.verify",
        target: input.provider, inputFingerprint: fingerprintManagementValue(input), resourceRevision: input.revision,
        safePreview: { model: input.model, reasoningEfforts: input.reasoningEfforts }, confirmationToken: input.sourceToken,
        resultCode: result.status }, "模型验证已完成，但审计记录失败");
      if (!response.destroyed && !controller.signal.aborted) sendManagementJson(response, 200, { ...result, auditStatus: completedAuditStatus });
    } catch (error) {
      recordProviderAudit(state, { sessionId: principalId, operation: "provider-model.verify", target: input.provider,
        inputFingerprint: fingerprintManagementValue(input), resourceRevision: input.revision,
        safePreview: { model: input.model, reasoningEfforts: input.reasoningEfforts }, confirmationToken: input.sourceToken,
        phase: "failed", resultCode: controller.signal.aborted ? "cancelled" : "verification-failed" }, "模型验证失败，审计记录失败");
      if (controller.signal.aborted && response.destroyed) return true;
      if (error instanceof ApiError) throw error;
      throw managementOperationError(error, [ProviderModelManagementError], "provider_models_unavailable");
    } finally {
      controller.abort();
      request.removeListener("aborted", disconnect);
      response.removeListener("close", disconnect);
      if (entry) state.snapshotReads.delete(entry);
      activeTemplateOptionsReads.delete(state);
    }
    return true;
  }
  if (path === "/provider-model-additions" && request.method === "POST") {
    if (new URL(request.url, "http://localhost").searchParams.size !== 0 || state.snapshotReadsClosed) {
      throw new ApiError(400, "provider_models_invalid_input", "新增模型候选请求不接受查询参数");
    }
    const input = await readJsonBody(request, maximumBodyBytes);
    if (state.snapshotReadsClosed) throw new ApiError(503, "provider_models_unavailable", "管理服务正在关闭，未读取模型候选");
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["provider", "manualModel", "discovery", "refresh"].includes(key))
      || input.discovery !== undefined && input.discovery !== true
      || input.refresh !== undefined && input.refresh !== true
      || typeof input.provider !== "string") {
      throw new ApiError(400, "provider_models_invalid_input", "新增模型候选参数无效");
    }
    if (activeTemplateOptionsReads.has(state)) {
      throw new ApiError(503, "provider_templates_busy", "已有模型候选读取正在进行，请稍后重试");
    }
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    activeTemplateOptionsReads.add(state);
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    if (request.aborted || response.destroyed) controller.abort();
    let entry;
    try {
      const task = loadProviderModelAdditionOptions(input.provider, {
        environment, signal: controller.signal,
        ...(Object.hasOwn(input, "manualModel") ? { manualModel: input.manualModel } : {}),
        ...(Object.hasOwn(input, "discovery") ? { discovery: input.discovery } : {}),
        ...(Object.hasOwn(input, "refresh") ? { refresh: input.refresh } : {}),
      });
      entry = { controller, settled: task.then(() => undefined, () => undefined) };
      state.snapshotReads.add(entry);
      const options = await task;
      controller.signal.throwIfAborted();
      sendManagementJson(response, 200, options);
    } catch (error) {
      if (controller.signal.aborted && response.destroyed) return true;
      throw managementOperationError(error, [ProviderModelManagementError], "provider_models_unavailable");
    } finally {
      controller.abort();
      request.removeListener("aborted", disconnect);
      response.removeListener("close", disconnect);
      if (entry) state.snapshotReads.delete(entry);
      activeTemplateOptionsReads.delete(state);
    }
    return true;
  }
  if (path === "/provider-model-request-options" && request.method === "GET") {
    const params = new URL(request.url, "http://localhost").searchParams;
    if (params.size !== 2 || params.getAll("provider").length !== 1 || params.getAll("model").length !== 1) {
      throw new ApiError(400, "provider_models_invalid_input", "请求改写读取参数无效");
    }
    try {
      const result = await loadManagedProviderModelRequestOptions(
        params.get("provider"), params.get("model"), { environment });
      sendManagementJson(response, 200, result);
    } catch (error) {
      if (error instanceof ProviderModelManagementError && error.code === "stale-preview") {
        throw new ApiError(409, "provider_models_stale_revision", "模型目录已变化，请刷新");
      }
      if (error instanceof ProviderModelManagementError && error.code === "invalid-input") {
        throw new ApiError(400, "provider_models_invalid_input", error.message);
      }
      throw new ApiError(503, "provider_models_unavailable", "请求改写暂不可用，请检查模型目录");
    }
    return true;
  }
  if (path === "/provider-model-templates" && request.method === "GET") {
    const params = new URL(request.url, "http://localhost").searchParams;
    if (params.size !== 1 || params.getAll("provider").length !== 1) {
      throw new ApiError(400, "provider_models_invalid_input", "模型模板请求参数无效");
    }
    if (activeTemplateOptionsReads.has(state)) {
      throw new ApiError(503, "provider_templates_busy", "已有模型模板读取正在进行，请稍后重试");
    }
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    activeTemplateOptionsReads.add(state);
    response.once("close", disconnect);
    if (response.destroyed) controller.abort();
    try {
      const options = await loadProviderModelTemplateOptions(params.get("provider"), { environment, signal: controller.signal });
      controller.signal.throwIfAborted();
      sendManagementJson(response, 200, options);
    } catch (error) {
      throw managementOperationError(error, [ProviderModelManagementError], "provider_models_unavailable");
    } finally {
      response.removeListener("close", disconnect);
      activeTemplateOptionsReads.delete(state);
    }
    return true;
  }
  if (path === "/provider-model-prompts" && request.method === "GET") {
    const params = new URL(request.url, "http://localhost").searchParams;
    if (params.size !== 3 || ["provider", "model", "revision"].some(key => params.getAll(key).length !== 1)) {
      throw new ApiError(400, "provider_models_invalid_input", "模型提示词请求参数无效");
    }
    try {
      const result = await loadProviderModelPrompts(Object.fromEntries(params), { environment });
      sendManagementJson(response, 200, result);
    } catch (error) {
      if (error instanceof ProviderModelManagementError && error.code === "stale-preview") {
        throw new ApiError(409, "provider_models_stale_revision", "模型目录已变化，请刷新");
      }
      if (error instanceof ProviderModelManagementError && error.code === "invalid-input") {
        throw new ApiError(400, "provider_models_invalid_input", "模型提示词请求参数无效");
      }
      throw new ApiError(503, "provider_models_unavailable", "模型目录无法安全读取");
    }
    return true;
  }
  if (await routeCustomModelCapabilityProbe({ environment, maximumBodyBytes, path, request, response, state })) return true;
  if (await routeResetCredits({ configPath, maximumBodyBytes, path, principalId, request, response, state })) return true;
  if (path === "/accounts/sources" && request.method === "GET") {
    const { accountMetadata, warnings } = loadAccountSources(environment);
    try {
      if (hasCodexAuthFile(environment)) {
        let config = {};
        try { config = parse(readCodexConfigFile(join(codexHomePath(environment), "config.toml"))); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
        if (config.model_provider === undefined || config.model_provider === "openai") {
          accountMetadata.unshift({ provider: "openai", accountId: null, displayName: "OpenAI", default: false });
        }
      }
    } catch {
      warnings.push({ source: "openai", code: "registry_unavailable", message: "OpenAI 账户来源暂不可用" });
    }
    sendManagementJson(response, 200, { accounts: accountMetadata, warnings });
    return true;
  }
  if (path === "/accounts/cloud-usage" && ["GET", "POST"].includes(request.method)) {
    const params = new URL(request.url, "http://localhost").searchParams;
    const cacheOnly = request.method === "GET";
    if (!cacheOnly && params.size !== 0) {
      throw new ApiError(400, "invalid_request", "云用量请求不接受查询参数");
    }
    if (cacheOnly && (params.size !== 2 || [...params.keys()].some(key => !["provider", "range"].includes(key)))) {
      throw new ApiError(400, "invalid_request", "缓存读取必须包含唯一账户和范围");
    }
    const body = cacheOnly ? { provider: params.get("provider"), range: params.get("range") }
      : await readJsonBody(request, Math.min(maximumBodyBytes, 4_096));
    if (!body || typeof body !== "object" || Array.isArray(body)
      || typeof body.provider !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(body.provider)
      || !["24h", "7d", "30d"].includes(body.range)
      || (Object.hasOwn(body, "refresh") && typeof body.refresh !== "boolean")
      || Object.keys(body).some(key => !["provider", "range", "refresh"].includes(key))) {
      throw new ApiError(400, "invalid_request", "云用量请求必须包含有效账户、范围与可选刷新标志");
    }
    if (!isOllamaCloudAccountProvider(body.provider)) {
      throw new ApiError(404, "provider_not_found", "账户来源不存在或不支持云用量");
    }
    let result;
    try {
      result = await readManagementSnapshot(request, response, state,
        signal => state.readGatewayCloudUsage(configPath, { ...body, cacheOnly }, signal));
    } catch (error) {
      if (response.destroyed) return true;
      if (error instanceof GatewayAccountRefreshError) {
        if (error.code === "provider_not_found") throw new ApiError(404, error.code, "账户来源不存在或不支持云用量");
        if (error.code === "invalid_request") throw new ApiError(400, error.code, "云用量请求无效");
        if (error.code === "refresh_failed") throw new ApiError(502, error.code, error.message);
        if (error.code === "invalid_response") throw new ApiError(502, error.code, "Gateway 云用量响应无效");
      }
      throw new ApiError(503, "gateway_unavailable", "Gateway 云用量接口不可用");
    }
    sendManagementJson(response, 200, result);
    return true;
  }
  if (path === "/accounts/refresh" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (
      !body
      || typeof body !== "object"
      || Array.isArray(body)
      || typeof body.provider !== "string"
      || Object.keys(body).some((key) => key !== "provider")
    ) {
      throw new ApiError(400, "invalid_account_refresh", "账户刷新请求必须包含唯一的 provider 字段");
    }
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", disconnect);
    if (response.destroyed) controller.abort();
    try {
      await state.refreshGatewayAccount(configPath, body.provider, controller.signal);
    } catch (error) {
      if (error instanceof GatewayAccountRefreshError) {
        if (error.code === "provider_not_found") throw new ApiError(404, error.code, error.message);
        if (error.code === "invalid_request") throw new ApiError(400, error.code, error.message);
        throw new ApiError(
          error.code === "refresh_failed" ? 502 : 503,
          error.code,
          error.message,
        );
      }
      throw new ApiError(503, "gateway_unavailable", "Gateway 账户刷新接口不可用");
    } finally {
      response.removeListener("close", disconnect);
    }
    await sendAccountSnapshots(environment, response, readMetrics, body.provider);
    return true;
  }
  if (path === "/provider-settings" && request.method === "GET") {
    let resource;
    try {
      resource = await readManagementSnapshot(request, response, state,
        signal => readProviderSettings(environment, state, signal));
    } catch {
      if (response.destroyed) return true;
      throw new ApiError(503, "provider_state_unavailable", "Provider 设置暂不可用，请检查 Codex 配置");
    }
    sendManagementJson(response, 200, {
      observedAt: new Date().toISOString(),
      resourceRevision: fingerprintManagementValue(resource),
      ...resource,
    });
    return true;
  }
  if (path === "/account-settings" && request.method === "GET") {
    const resource = await readAccountSettings(environment, state);
    sendManagementJson(response, 200, {
      observedAt: new Date().toISOString(),
      resourceRevision: fingerprintManagementValue(resource),
      ...resource,
    });
    return true;
  }
  if (path === "/account-settings/discover-models" && request.method === "POST") {
    if (new URL(request.url, "http://localhost").searchParams.size !== 0) throw new ApiError(400, "invalid_account_operation", "账户模型发现不接受查询参数");
    const input = await readJsonBody(request, Math.min(maximumBodyBytes, 16_384));
    if (activeTemplateOptionsReads.has(state)) throw new ApiError(503, "provider_templates_busy", "已有模型候选读取正在进行，请稍后重试");
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    activeTemplateOptionsReads.add(state);
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    if (request.aborted || response.destroyed || state.snapshotReadsClosed) controller.abort();
    let entry;
    try {
      const task = discoverAccountSettingsModels(input, environment, { signal: controller.signal });
      entry = { controller, settled: task.then(() => undefined, () => undefined) };
      state.snapshotReads.add(entry);
      const discovery = await task;
      controller.signal.throwIfAborted();
      sendManagementJson(response, 200, discovery);
    } catch (error) {
      if (controller.signal.aborted && response.destroyed) return true;
      throw error;
    } finally {
      controller.abort();
      request.removeListener("aborted", disconnect);
      response.removeListener("close", disconnect);
      if (entry) state.snapshotReads.delete(entry);
      activeTemplateOptionsReads.delete(state);
    }
    return true;
  }
  if (path === "/account-settings/preview" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    const input = normalizeAccountSettingsMutation(body);
    return withAccountSettingsRequest(request, response, state, input.operation, async options => {
      const preview = await state.previewAccountSettings(input, environment, options);
      options.signal?.throwIfAborted();
      const safePreview = redactAccountSettingsResult(preview);
      const resource = await readAccountSettings(environment, state);
      const inputFingerprint = fingerprintManagementValue(input);
      const resourceRevision = fingerprintManagementValue(resource);
      const issued = state.confirmations.issue({
        sessionId: principalId,
        operation: "account-settings.write",
        inputFingerprint,
        resourceRevision,
        previewFingerprint: fingerprintManagementValue(safePreview),
      });
      sendManagementJson(response, 200, {
        preview: safePreview,
        resourceRevision,
        confirmationToken: issued.token,
        confirmationExpiresAt: issued.expiresAt,
      });
      return true;
    });
  }
  if (path === "/account-settings" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.confirmationToken !== "string") {
      throw new ApiError(400, "invalid_json", "账户设置写入请求必须包含 confirmationToken");
    }
    const input = normalizeAccountSettingsMutation(body);
    return withAccountSettingsRequest(request, response, state, input.operation, async options => {
      const resource = await readAccountSettings(environment, state);
      const preview = await state.previewAccountSettings(input, environment, { ...options, authentication: "defer-to-apply" });
      options.signal?.throwIfAborted();
      const safePreview = redactAccountSettingsResult(preview);
      const inputFingerprint = fingerprintManagementValue(input);
      const resourceRevision = fingerprintManagementValue(resource);
      state.confirmations.consume(body.confirmationToken, {
        sessionId: principalId,
        operation: "account-settings.write",
        inputFingerprint,
        resourceRevision,
        previewFingerprint: fingerprintManagementValue(safePreview),
      });
      let result;
      try {
        options.signal?.throwIfAborted();
        assertManagementAuditWritable(state.audit);
        result = await state.applyAccountSettings(input, environment, safePreview, options);
      } catch (error) {
        throw managementOperationError(error, [], "account_settings_failed");
      }
      invalidateProviderManagementSummary(state.providerStateCache);
      invalidateServiceStatusSummary(state.serviceStatusCache);
      const auditStatus = recordProviderAudit(state, {
        sessionId: principalId,
        operation: "account-settings.write",
        target: accountSettingsAuditTarget(input),
        inputFingerprint,
        resourceRevision,
        safePreview,
        confirmationToken: body.confirmationToken,
        resultCode: result.action ?? "updated",
      }, "账户设置已写入，但审计记录失败");
      sendManagementJson(response, 200, { ...redactAccountSettingsResult(result), auditStatus });
      return true;
    });
  }
  if (path === "/provider-settings/preview" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    const input = normalizeProviderSettingsMutation(body);
    if (input.operation === "provider.web-search" || input.operation === "model.custom.save" || input.operation === "primary.custom.connection.save" || input.operation === "primary.custom.save" && input.provider.operation === "update") {
      const current = await readProviderSettings(environment, state);
      if (input.resourceRevision !== fingerprintManagementValue(current)) {
        throw new ApiError(409, "stale-preview", "模型设置已变化，请刷新后重新编辑");
      }
    }
    const preview = await state.previewProviderSettings(input, environment);
    const safePreview = redactProviderSettingsResult(preview);
    const resource = await readProviderSettings(environment, state);
    const inputFingerprint = fingerprintManagementValue(input);
    const resourceRevision = fingerprintManagementValue(resource);
    if ((input.operation === "provider.web-search" || input.operation === "model.custom.save" || input.operation === "primary.custom.connection.save" || input.operation === "primary.custom.save" && input.provider.operation === "update")
      && input.resourceRevision !== resourceRevision) {
      throw new ApiError(409, "stale-preview", "模型设置已变化，请刷新后重新编辑");
    }
    const issued = state.confirmations.issue({
      sessionId: principalId,
      operation: "provider-settings.write",
      inputFingerprint,
      resourceRevision,
      previewFingerprint: fingerprintManagementValue(safePreview),
    });
    sendManagementJson(response, 200, {
      preview: safePreview,
      resourceRevision,
      confirmationToken: issued.token,
      confirmationExpiresAt: issued.expiresAt,
    });
    return true;
  }
  if (path === "/provider-settings" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.confirmationToken !== "string") {
      throw new ApiError(400, "invalid_json", "Provider 设置写入请求必须包含 confirmationToken");
    }
    const input = normalizeProviderSettingsMutation(body);
    const resource = await readProviderSettings(environment, state);
    const inputFingerprint = fingerprintManagementValue(input);
    const resourceRevision = fingerprintManagementValue(resource);
    if ((input.operation === "provider.web-search" || input.operation === "model.custom.save" || input.operation === "primary.custom.connection.save" || input.operation === "primary.custom.save" && input.provider.operation === "update")
      && input.resourceRevision !== resourceRevision) {
      throw new ApiError(409, "stale-preview", "模型设置已变化，请刷新后重新编辑");
    }
    const preview = await state.previewProviderSettings(input, environment);
    const safePreview = redactProviderSettingsResult(preview);
    state.confirmations.consume(body.confirmationToken, {
      sessionId: principalId,
      operation: "provider-settings.write",
      inputFingerprint,
      resourceRevision,
      previewFingerprint: fingerprintManagementValue(safePreview),
    });
    let result;
    try {
      assertManagementAuditWritable(state.audit);
      result = await state.applyProviderSettings(input, environment, safePreview);
    } catch (error) {
      throw managementOperationError(error, [], "provider_settings_failed");
    }
    invalidateProviderManagementSummary(state.providerStateCache);
    invalidateServiceStatusSummary(state.serviceStatusCache);
    const auditStatus = recordProviderAudit(state, {
      sessionId: principalId,
      operation: "provider-settings.write",
      target: providerSettingsAuditTarget(input),
      inputFingerprint,
      resourceRevision,
      safePreview,
      confirmationToken: body.confirmationToken,
      resultCode: result.action ?? "updated",
    }, "Provider 设置已写入，但审计记录失败");
    sendManagementJson(response, 200, { ...redactProviderSettingsResult(result), auditStatus });
    return true;
  }
  if (path === "/providers" && request.method === "GET") {
    let providers;
    try {
      providers = await readManagementSnapshot(request, response, state,
        signal => loadProviderManagementSummary(environment, state, signal));
    } catch {
      if (response.destroyed) return true;
      throw new ApiError(503, "provider_state_unavailable", "Provider 状态暂不可用，请使用 codexc setup 查看");
    }
    sendManagementJson(response, 200, providers);
    return true;
  }
  return false;
}

export async function sendAccountSnapshots(environment, response, readMetrics, provider) {
  // A refresh owns one Provider; the separate GET remains the authoritative list.
  const storedSnapshots = await readMetrics({ operation: "accounts", nowMs: Date.now(), ...(provider === undefined ? {} : { provider }) }, response);
  if (response.destroyed) return;
  const { warnings, dsAccounts, ocgAccounts, ccgAccounts, clineAccounts, ollamaAccounts, accountMetadata } = loadAccountSources(environment);
  const metadataByProvider = new Map(accountMetadata.map((account) => [account.provider, account]));
  const snapshots = storedSnapshots
    .filter((snapshot) => {
      if (["deepseek", "ocg", "ccg", "clp", "olc"].includes(snapshot.provider)) return false;
      if (snapshot.provider.startsWith("olc-")) return ollamaAccounts === null || metadataByProvider.has(snapshot.provider);
      if (snapshot.provider.startsWith("clp-")) return clineAccounts === null || metadataByProvider.has(snapshot.provider);
      const registry = snapshot.provider.startsWith("ds-")
        ? dsAccounts
        : snapshot.provider.startsWith("ocg-")
          ? ocgAccounts
          : snapshot.provider.startsWith("ccg-")
            ? ccgAccounts
            : null;
      return registry === null || metadataByProvider.has(snapshot.provider);
    })
    .map((snapshot) => {
      const account = metadataByProvider.get(snapshot.provider);
      return {
        ...snapshot,
        displayName: account?.displayName ?? snapshot.provider,
        default: account?.default ?? false,
      };
    });
  for (const account of accountMetadata) {
    if (provider !== undefined && account.provider !== provider) continue;
    if (snapshots.some((snapshot) => snapshot.provider === account.provider)) continue;
    snapshots.push({
      provider: account.provider,
      accountId: account.accountId,
      observedAtMs: 0,
      available: false,
      usage: { kind: "unsupported", provider: account.provider },
      limits: { kind: "unsupported", provider: account.provider },
      displayName: account.displayName,
      default: account.default,
    });
  }
  for (const snapshot of snapshots) {
    if (snapshot.provider !== "openai") continue;
    const limits = snapshot.limits;
    snapshot.credentialRefreshedAt = await readOpenAiCredentialRefreshTime(
      limits?.kind === "rate-limits" && limits.provider === "openai" ? limits.limits?.accountId : null,
      environment,
    );
  }
  if (!response.destroyed) {
    sendJson(response, 200, {
      observedAtMs: snapshots.reduce((latest, item) => Math.max(latest, item.observedAtMs), 0), snapshots, warnings,
    });
  }
}

function loadAccountSources(environment) {
  const warnings = [];
  const dsAccounts = loadAccountRegistry(
    () => loadDeepseekAccounts(environment),
    warnings,
    "deepseek",
    "DeepSeek 账户元数据暂不可用",
  );
  const ocgAccounts = loadAccountRegistry(
    () => loadOpencodeGoAccounts(environment),
    warnings,
    "opencode-go",
    "OpenCode Go 账户元数据暂不可用",
  );
  const ccgAccounts = loadAccountRegistry(
    () => loadCcgAccounts(environment),
    warnings,
    "ccg",
    "CommandCode Go 账户元数据暂不可用",
  );
  const clineAccounts = loadAccountRegistry(
    () => loadClinePassAccounts(environment),
    warnings,
    "clp",
    "Cline Pass 配置暂不可用",
  );
  const ollamaAccounts = loadAccountRegistry(
    () => loadOllamaCloudAccounts(environment), warnings, "ollama-cloud", "Ollama Cloud 账户元数据暂不可用",
  );
  const accountMetadata = [
    ...(ollamaAccounts ?? []).map(account => ({ provider: ollamaCloudProviderId(account.id), accountId: account.id, displayName: `Ollama Cloud ${account.id}`, default: account.default })),
    ...(clineAccounts ?? []).map(account => ({ provider: clinePassProviderId(account.id), accountId: account.id, displayName: `Cline Pass ${account.id}`, default: account.default })),
    ...(dsAccounts ?? []).map((account) => ({
      provider: deepseekProviderId(account.id),
      accountId: account.id,
      displayName: `DS ${account.id}`,
      default: account.default,
    })),
    ...(ocgAccounts ?? []).map((account) => ({
      provider: opencodeGoProviderId(account.id),
      accountId: account.id,
      displayName: opencodeGoAccountDisplayName(account),
      default: account.default,
    })),
    ...(ccgAccounts ?? []).map((account) => ({
      provider: ccgProviderId(account.id),
      accountId: account.id,
      displayName: `CommandCode Go ${account.id}`,
      default: account.default,
    })),
  ];
  return { warnings, dsAccounts, ocgAccounts, ccgAccounts, clineAccounts, ollamaAccounts, accountMetadata };
}

function loadAccountRegistry(load, warnings, source, message) {
  try {
    return load();
  } catch {
    warnings.push({ source, code: "registry_unavailable", message });
    return null;
  }
}

function recordProviderAudit(state, details, failureMessage) {
  try {
    state.audit.record({
      sessionId: details.sessionId,
      source: "webui",
      operation: details.operation,
      target: details.target,
      inputFingerprint: details.inputFingerprint,
      revision: details.resourceRevision,
      previewId: fingerprintManagementValue(details.safePreview),
      confirmationId: fingerprintManagementValue(details.confirmationToken),
      phase: details.phase ?? "completed",
      resultCode: details.resultCode,
      recovery: "none",
    });
    return "recorded";
  } catch (error) {
    webuiLogger.error({ module: "audit", event: "provider.audit_failed", err: error }, failureMessage);
    return "degraded";
  }
}

function providerSettingsAuditTarget(input) {
  if (input.operation === "model.add") return `models:${fingerprintManagementValue({ provider: input.provider, models: input.models })}`;
  if (input.operation === "model.remove" || input.operation === "model.custom.save" || input.operation === "model.context" || input.operation === "model.rename" || input.operation === "model.template.update" || input.operation === "model.request-options") return `model:${fingerprintManagementValue({ provider: input.provider, model: input.model })}`;
  if (input.operation === "primary.custom.save" || input.operation === "primary.custom.connection.save") return String(input.provider?.providerId ?? "unknown");
  if (input.operation === "managed.default" || input.operation === "provider.web-search") return String(input.provider ?? "unknown");
  return String(input.providerId ?? "unknown");
}

function accountSettingsAuditTarget(input) {
  if (input.operation.startsWith("olc.")) return `olc-${input.accountId}`;
  if (input.operation.startsWith("clp.")) return clinePassProviderId(input.accountId);
  if (input.operation.startsWith("opencode.account.")) return String(input.accountId ?? "unknown");
  return input.operation.startsWith("deepseek.") ? "deepseek" : "unknown";
}

async function readProviderSettings(environment, state, signal) {
  try {
    return await loadProviderSettingsResource(environment,
      options => state.loadProviderState({ ...options, signal }));
  } catch {
    throw new ApiError(503, "provider_state_unavailable", "Provider 设置暂不可用，请检查 Codex 配置");
  }
}

async function readAccountSettings(environment, state) {
  try {
    return await state.loadAccountSettings(environment);
  } catch {
    throw new ApiError(503, "account_state_unavailable", "账户设置暂不可用，请检查 Provider 配置");
  }
}

async function withAccountSettingsRequest(request, response, state, operationId, operation) {
  if (!operationId.startsWith("olc.")) return operation({});
  return readManagementSnapshot(request, response, state, signal => operation({ signal }));
}
