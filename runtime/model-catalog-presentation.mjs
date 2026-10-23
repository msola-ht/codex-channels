/** Pure, allowlisted presentation of saved Codex-compatible model catalogues. */
export class ModelCatalogPresentationError extends Error {
  constructor() { super("模型目录展示字段无效"); this.name = "ModelCatalogPresentationError"; }
}
function fail() { throw new ModelCatalogPresentationError(); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasControlCharacters(value) { return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function catalogText(value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256 || hasControlCharacters(value)) fail("invalid_catalog");
  return value;
}
function catalogWindow(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_catalog");
  return value;
}
export function projectModelCatalogEntries(models, hasIdentity = false, definitions) {
  if (!Array.isArray(models) || models.length === 0) fail("invalid_catalog");
  const declarations = definitions === undefined ? undefined : projectDeclarations(definitions);
  const seen = new Set();
  const projected = [];
  for (const model of models) {
    if (!record(model)) fail("invalid_catalog");
    const slug = catalogText(model.slug);
    if (seen.has(slug) || !["list", "hide", "none"].includes(model.visibility)
      || typeof model.supported_in_api !== "boolean") fail("invalid_catalog");
    seen.add(slug);
    if (model.visibility !== "list" || !model.supported_in_api) continue;
    if (!Array.isArray(model.supported_reasoning_levels)) fail("invalid_catalog");
    const reasoningEfforts = model.supported_reasoning_levels.map(entry => catalogText(entry?.effort));
    const defaultReasoningEffort = model.default_reasoning_level == null ? null : catalogText(model.default_reasoning_level);
    if (new Set(reasoningEfforts).size !== reasoningEfforts.length
      || (defaultReasoningEffort !== null && !reasoningEfforts.includes(defaultReasoningEffort))) fail("invalid_catalog");
    const contextWindow = catalogWindow(model.context_window);
    const maxContextWindow = catalogWindow(model.max_context_window);
    const serviceTiers = model.service_tiers === undefined ? [] : projectServiceTiers(model.service_tiers);
    const approvals = projectApprovals(model.model_messages);
    projected.push({
      model: slug,
      displayName: catalogText(model.display_name),
      contextWindow,
      maxContextWindow,
      reasoningEfforts,
      defaultReasoningEffort,
      serviceTiers,
      approvals,
      details: projectDetails(model),
      editable: hasIdentity && maxContextWindow !== null,
      ...(declarations === undefined ? {} : { declaredCapabilities: declarations.get(slug) ?? fail("invalid_catalog") }),
    });
  }
  return projected;
}

function projectDeclarations(definitions) {
  if (!Array.isArray(definitions)) fail("invalid_catalog");
  const declarations = new Map();
  for (const definition of definitions) {
    if (!record(definition)) fail("invalid_catalog");
    const id = catalogText(definition.id);
    if (declarations.has(id)) fail("invalid_catalog");
    const { reasoningEfforts, supportsImages, applyPatchToolType, supportsSearchTool } = definition;
    if (reasoningEfforts !== undefined && (!Array.isArray(reasoningEfforts)
      || new Set(reasoningEfforts.map(catalogText)).size !== reasoningEfforts.length)) fail("invalid_catalog");
    if ((supportsImages !== undefined && typeof supportsImages !== "boolean")
      || (supportsSearchTool !== undefined && typeof supportsSearchTool !== "boolean")
      || (applyPatchToolType !== undefined && applyPatchToolType !== null && applyPatchToolType !== "freeform")) fail("invalid_catalog");
    declarations.set(id, {
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts: [...reasoningEfforts] }),
      ...(supportsImages === undefined ? {} : { supportsImages }),
      ...(applyPatchToolType === undefined ? {} : { applyPatchToolType }),
      ...(supportsSearchTool === undefined ? {} : { supportsSearchTool }),
    });
  }
  return declarations;
}

function projectDetails(model) {
  const details = {};
  for (const key of ["include_skills_usage_instructions", "include_plugin_usage_instructions", "include_apps_usage_instructions",
    "supports_reasoning_summary_parameter", "support_verbosity", "supports_image_detail_original", "supports_search_tool",
    "supports_experimental_context", "supports_reasoning_effort_updates", "node_repl_auto_review_required", "node_repl_disabled", "use_responses_lite"]) {
    const value = model[key];
    if (value != null && typeof value !== "boolean") fail("invalid_catalog");
    details[key] = value ?? null;
  }
  for (const key of ["default_reasoning_summary", "default_verbosity", "apply_patch_tool_type", "web_search_tool_type",
    "shell_type", "tool_mode", "multi_agent_version", "multi_agent_reasoning_effort"]) {
    details[key] = model[key] == null ? null : catalogText(model[key]);
  }
  for (const key of ["input_modalities", "experimental_supported_tools"]) {
    const value = model[key];
    if (value != null && !Array.isArray(value)) fail("invalid_catalog");
    details[key] = value == null ? null : value.map(catalogText);
  }
  for (const key of ["effective_context_window_percent", "auto_compact_token_limit"]) {
    const value = model[key];
    if (value != null && (!Number.isSafeInteger(value) || value < 0
      || (key === "effective_context_window_percent" && value > 100))) fail("invalid_catalog");
    details[key] = value ?? null;
  }
  const policy = model.truncation_policy;
  if (policy != null && (!record(policy) || !["tokens", "bytes"].includes(policy.mode)
    || !Number.isSafeInteger(policy.limit) || policy.limit < 0)) fail("invalid_catalog");
  details.truncation_policy = policy == null ? null : { mode: policy.mode, limit: policy.limit };
  return details;
}

function projectServiceTiers(value) {
  if (!Array.isArray(value)) fail("invalid_catalog");
  const seen = new Set();
  return value.map(tier => {
    if (!record(tier)) fail("invalid_catalog");
    const id = catalogText(tier.id);
    if (seen.has(id)) fail("invalid_catalog");
    seen.add(id);
    const description = tier.description == null || tier.description === "" ? null : catalogText(tier.description);
    const speedMatch = description?.match(/(?:^|\s)(\d+(?:\.\d+)?)x\s+speed\b/iu);
    const speed = speedMatch ? Number(speedMatch[1]) : null;
    return { id, name: catalogText(tier.name), description,
      speedMultiplier: speed !== null && Number.isFinite(speed) && speed > 0 ? speed : null };
  });
}

function projectApprovals(messages) {
  if (messages != null && !record(messages)) fail("invalid_catalog");
  const approvals = messages?.approvals;
  if (approvals != null && !record(approvals)) fail("invalid_catalog");
  return ["on_request", "on_request_auto_review", "never", "unless_trusted"].map(mode => {
    const value = approvals?.[mode];
    if (value != null && typeof value !== "string") fail("invalid_catalog");
    return { mode, state: value == null ? "default" : value === "" ? "empty" : "custom" };
  });
}


const promptGroups = {
  general: ["instructions_template", "persistent_instructions", "content_filter_guidance"],
  approvals: ["approvals.on_request", "approvals.on_request_auto_review", "approvals.never", "approvals.unless_trusted"],
  collaboration: ["collaboration_modes.default", "collaboration_modes.plan"],
  review: ["auto_review.policy", "auto_review.policy_template", "auto_review.node_repl_policy", "auto_review.rejection_instructions", "auto_review.timeout_instructions", "guardian_v2.classifier_instructions"],
  permissions: ["permissions.danger_full_access", "permissions.workspace_write", "permissions.read_only", "permissions.approved_prefixes"],
  agents: ["multi_agent.role.root", "multi_agent.role.subagent", "multi_agent.mode.explicit", "multi_agent.mode.proactive", "multi_agent.mode.hint_text"],
  budget: ["token_budget.reminder_message_template", "token_budget.guidance_message", "token_budget.auto_compact_fallback_prompt"],
  confirmation: ["confirmation_policies.browser_use", "confirmation_policies.computer_use"],
  tools: ["tools.send_user_message_async.description", "tools.code_mode.exec.description", "tools.code_mode.wait.description", "tools.code_mode.deferred_nested_tools_guidance", "tools.code_mode.mcp_typescript_preamble",
    ...["tool_update_hint", "removed_tools_header", "removed_namespaces_header", "namespace_instructions_prefix", "namespace_instructions_cleared"].map(name => `tools.incremental_tools.${name}`),
    ...["spawn_agent", "send_message", "followup_task", "wait_agent", "interrupt_agent", "list_agents", "create_channel", "get_channels", "list_threads", "search_posts", "read_thread", "read_post", "subscribe", "unsubscribe", "post"].map(name => `tools.multi_agent.${name}.description`),
    ...["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].map(name => `tools.mcp_resources.${name}.description`)],
};


export function projectModelPrompts(messages) {
  const groups = Object.entries(promptGroups).map(([group, paths]) => {
    const entries = [];
    for (const path of paths) {
      const value = readPromptField(messages, path);
      if (value == null) continue;
      if (typeof value !== "string") fail("invalid_catalog");
      entries.push({ path: `model_messages.${path}`, text: value });
    }
    if (group === "tools") {
      for (const path of ["tools.functions_namespace_functions_description_prefixes", "tools.indirect_description_prefixes.namespaces", "tools.indirect_description_prefixes.mcp_servers"]) {
        const prefixes = readPromptField(messages, path);
        if (prefixes == null) continue;
        if (!record(prefixes) || Object.keys(prefixes).length > 512) fail("invalid_catalog");
        for (const [name, text] of Object.entries(prefixes)) {
          catalogText(name);
          if (typeof text !== "string") fail("invalid_catalog");
          entries.push({ path: `model_messages.${path}.${name}`, text });
        }
      }
    }
    return { group, entries };
  });
  if (groups.reduce((count, group) => count + group.entries.length, 0) > 512) fail("invalid_catalog");
  return groups;
}
function readPromptField(messages, path) {
  let value = messages;
  for (const segment of path.split(".")) {
    if (value == null) return undefined;
    if (!record(value)) fail("invalid_catalog");
    value = Object.hasOwn(value, segment) ? value[segment] : undefined;
  }
  return value;
}
