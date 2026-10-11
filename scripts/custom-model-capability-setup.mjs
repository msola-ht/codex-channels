import { probeCustomModelCapabilities } from "./custom-model-capability-probe.mjs";

const labels = {
  text: "文本响应", tools: "函数调用与结果回传", images: "图片输入",
  applyPatch: "apply_patch", toolSearch: "工具检索与结果回传",
  reasoningNone: "none 请求", reasoningMedium: "medium 思考",
};
const statuses = { supported: "通过", unsupported: "未通过", inconclusive: "无法确认" };

/** Probe drafts only; the caller owns the existing preview/write transaction. */
export async function promptCustomModelCapabilities(prompts, input, {
  output = process.stdout, probe = probeCustomModelCapabilities,
} = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const models = [];
    for (const [index, model] of input.models.entries()) {
      while (true) {
        if (controller.signal.aborted) return undefined;
        output.write(`\n正在探测模型 ${index + 1}/${input.models.length}：${model.id}；每个模型最长 120 秒，Ctrl+C 取消。\n`);
        const result = await probe({ baseUrl: input.baseUrl, apiKey: input.apiKey, model: model.id,
          upstreamWireApi: input.upstreamWireApi, environment: input.environment, signal: controller.signal });
        if (controller.signal.aborted || result.status === "cancelled") return undefined;
        if (result.model !== model.id || result.upstreamWireApi !== input.upstreamWireApi) {
          throw new Error("模型探测结果与当前模型或上游接口不匹配，未保存配置");
        }
        for (const check of result.checks) {
          output.write(`- ${labels[check.capability]}：${statuses[check.status]}；${check.reason}${check.httpStatus === undefined ? "" : `（HTTP ${check.httpStatus}）`}\n`);
        }
        const canApply = result.status === "completed"
          && ["text", "tools"].every(capability => result.checks.some(check => check.capability === capability && check.status === "supported"))
          && result.capabilities.reasoningEfforts.length > 0;
        if (canApply) {
          models.push({ ...model, ...result.capabilities, applyPatchToolType: result.capabilities.applyPatchToolType });
          output.write("已将本模型探测结果填入待保存目录；未验证的可选能力不声明，上下文和模板关联保持填写值。\n");
          break;
        }
        output.write("基础文本、工具接续或可用思考参数尚未验证，不能自动写入本模型；此前模型的结果也尚未保存。\n");
        const action = await prompts.select({
          message: `模型 ${model.id} 未完成验证`,
          options: [{ value: "cancel", label: "取消添加，稍后重试或选择手动填写" },
            { value: "retry", label: "重新探测此模型（可能计费）" }],
          initialValue: "cancel",
        });
        if (controller.signal.aborted || prompts.isCancel(action) || action === "cancel") return undefined;
        if (action !== "retry") throw new Error("模型能力探测操作无效");
      }
    }
    return controller.signal.aborted ? undefined : models;
  } finally {
    process.removeListener("SIGINT", cancel);
    controller.abort();
  }
}
