import type { MessageKey, Translate } from "@/lib/i18n/messages"

// Only the engine's designated fixed reasons are displayed, never upstream text.
const reasons: Record<string, MessageKey> = {
  "本次短任务的输出或工具关联未通过验证": "modelProbe.reasons.taskFailed",
  "模型能力检测已取消": "modelProbe.reasons.cancelled",
  "模型能力检测总预算已耗尽": "modelProbe.reasons.budget",
  "模型能力检测请求次数已达到上限": "modelProbe.reasons.requestLimit",
  "上游响应超过模型能力检测大小限制": "modelProbe.reasons.tooLarge",
  "上游未返回有效 JSON": "modelProbe.reasons.invalidJson",
  "上游未返回完整且可验证的模型响应": "modelProbe.reasons.incomplete",
  "模型能力检测请求超时": "modelProbe.reasons.timeout",
  "模型能力检测网络、TLS、代理或请求转换失败": "modelProbe.reasons.network",
  "模型能力检测响应读取失败": "modelProbe.reasons.readFailed",
  "函数调用及模拟工具结果回传已通过": "modelProbe.reasons.tools",
  "非流式文本短任务已通过": "modelProbe.reasons.text",
  "思考参数无效值对照未被明确拒绝，无法确认 none 控制有效": "modelProbe.reasons.noneControl",
  "思考参数无效值对照未被明确拒绝，无法确认 medium 控制有效": "modelProbe.reasons.mediumControl",
  "none 请求成功且无思考；观察到零思考 Token 或与 medium 存在思考输出差异": "modelProbe.reasons.none",
  "none 请求兼容，但缺少关闭思考的可观察证据；缺失用量不视为零": "modelProbe.reasons.noneUnconfirmed",
  "medium 请求观察到思考文本或正思考 Token；未验证其他强度档位": "modelProbe.reasons.medium",
  "medium 请求兼容，但没有可观察的思考文本或正思考 Token": "modelProbe.reasons.mediumUnconfirmed",
  "随机多色块 PNG 完整序列识别短任务已通过": "modelProbe.reasons.images",
  "自由格式补丁调用及模拟结果回传已通过；未执行补丁": "modelProbe.reasons.patch",
  "经 Chat 桥的 input 函数补丁调用及模拟结果回传已通过；未执行补丁": "modelProbe.reasons.chatPatch",
  "客户端检索、发现工具调用及模拟结果回传已通过": "modelProbe.reasons.search",
  "经 Chat 桥函数映射的客户端检索、发现工具调用及结果回传已通过": "modelProbe.reasons.chatSearch",
  "模型能力检测总预算或代理发现预算已耗尽": "modelProbe.reasons.discoveryBudget",
  "模型能力检测代理配置或发现失败": "modelProbe.reasons.proxy",
  "基础文本、思考控制或工具未通过，未继续检测此项": "modelProbe.reasons.skipped",
  "模型能力检测认证或权限失败": "modelProbe.reasons.auth",
  "模型能力检测受到上游限流": "modelProbe.reasons.rateLimit",
  "上游明确拒绝本项检测使用的输入或参数": "modelProbe.reasons.rejected",
  "上游拒绝请求，无法确认本项能力": "modelProbe.reasons.requestRejected",
}

export function translateCustomModelProbeReason(t: Translate, reason: string): string {
  return t(Object.hasOwn(reasons, reason) ? reasons[reason]! : "modelProbe.reasons.unknown")
}
