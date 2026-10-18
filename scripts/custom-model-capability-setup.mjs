import { probeCustomModelCapabilities } from "./custom-model-capability-probe.mjs";
import { customModelProbeConnection } from "./custom-primary-provider-management.mjs";
import { withCliProgress } from "./cli-operation-progress.mjs";

const labels = { applyPatch: "apply_patch", toolSearch: "tool_search", webSearch: "原生网页搜索 web_search" };
const statuses = { supported: "通过", unsupported: "未通过", inconclusive: "无法确认" };

/** Ask about each tool separately; requests require an explicit selection. */
export async function promptCustomModelCapabilities(prompts, input, {
  output = process.stdout, probe = probeCustomModelCapabilities, optionalProbe = false,
} = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const models = [];
    const probeConnections = [];
    for (const model of input.models) {
      const draft = { ...model };
      if (optionalProbe) {
        const detect = await prompts.confirm({ message: `是否探测 ${model.id} 的工具能力？（可选，可能计费；No 保留手动声明）`, initialValue: false });
        if (prompts.isCancel(detect) || controller.signal.aborted) return undefined;
        if (detect !== true) { models.push(draft); continue; }
      }
      const connection = { baseUrl: input.baseUrl, apiKey: input.apiKey, model: model.id,
        upstreamWireApi: input.upstreamWireApi, reasoningEffort: model.defaultReasoningEffort ?? "none" };
      for (const capability of ["applyPatch", "toolSearch", "webSearch"]) {
      let result;
      while (true) {
        if (controller.signal.aborted) return undefined;
        const current = capability === "applyPatch" ? draft.applyPatchToolType === undefined ? undefined : draft.applyPatchToolType === "freeform" : draft.supportsSearchTool;
        const canApply = result?.status === "completed" && ["supported", "unsupported"].includes(result.check.status);
        const action = await prompts.select(capability === "webSearch" ? {
          message: `是否检测 ${model.id} 的原生网页搜索？仅诊断，不修改模型能力或启用搜索策略。`,
          options: [
            { value: "skip", label: "继续，保留当前设置" },
            { value: "detect", label: result ? "重新检测原生网页搜索" : "检测原生网页搜索", hint: "1 次请求；上游可能实际搜索并产生模型及搜索费用" },
            { value: "cancel", label: "取消本次修改，不保存" },
          ],
          initialValue: "skip",
        } : {
          message: `模型 ${model.id} 是否支持 ${labels[capability]}？`,
          options: [
            ...(canApply ? [{ value: "apply", label: `采用本项检测结果：${result.check.status === "supported" ? "支持" : "不声明支持"}` }] : []),
            { value: "yes", label: "手动声明支持" },
            { value: "no", label: "不支持" },
            { value: "unknown", label: "未知（保存但暂不启用）" },
            { value: "detect", label: result ? "重新探测本项" : "探测本项", hint: `${capability === "applyPatch" ? "最多 2" : "最多 3"} 次短请求，可能计费；不执行返回的工具` },
            { value: "cancel", label: "取消本次修改，不保存" },
          ],
          initialValue: canApply ? "apply" : current === undefined ? "unknown" : current ? "yes" : "no",
        });
        if (controller.signal.aborted || prompts.isCancel(action) || action === "cancel") return undefined;
        if (capability === "webSearch" && action === "skip") break;
        if (action === "detect") {
          output.write(`\n正在探测 ${model.id} 的 ${labels[capability]}，最长 45 秒；Ctrl+C 取消。\n`);
          try {
            result = await withCliProgress(`探测 ${model.id} 的 ${labels[capability]}`, progress =>
              probe({ ...connection, capability, environment: input.environment, signal: progress.signal }),
            { output, delayMs: 150, signal: controller.signal });
          } catch (error) {
            if (controller.signal.aborted) return undefined;
            throw error;
          }
          if (controller.signal.aborted || result.status === "cancelled") return undefined;
          if (result.model !== model.id || result.upstreamWireApi !== input.upstreamWireApi
            || result.capability !== capability || result.check.capability !== capability || result.reasoningEffort !== connection.reasoningEffort) {
            throw new Error("工具探测结果与当前模型、协议或思考参数不匹配，未保存配置");
          }
          output.write(`- ${labels[capability]}：${statuses[result.check.status]}；${result.check.reason}${result.check.httpStatus === undefined ? "" : `（HTTP ${result.check.httpStatus}）`}\n`);
          continue;
        }
        if (capability === "webSearch" || !["yes", "no", "unknown", "apply"].includes(action) || (action === "apply" && !canApply)) throw new Error("工具能力选择无效");
        const supported = action === "apply" ? result.check.status === "supported" : action === "yes";
        if (capability === "applyPatch") {
          if (action === "unknown") delete draft.applyPatchToolType;
          else draft.applyPatchToolType = supported ? "freeform" : null;
        } else if (action === "unknown") delete draft.supportsSearchTool;
        else draft.supportsSearchTool = supported;
        if (action === "apply") probeConnections.push({ model: model.id, capability, token: customModelProbeConnection({ ...connection, capability }) });
        break;
      }
      }
      models.push(draft);
    }
    return controller.signal.aborted ? undefined : { models, probeConnections };
  } finally {
    process.removeListener("SIGINT", cancel);
    controller.abort();
  }
}
