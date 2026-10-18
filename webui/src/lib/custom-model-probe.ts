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
  "自由格式补丁调用及模拟结果回传已通过；未执行补丁": "modelProbe.reasons.patch",
  "经 Chat 桥的 input 函数补丁调用及模拟结果回传已通过；未执行补丁": "modelProbe.reasons.chatPatch",
  "客户端检索、发现工具调用及模拟结果回传已通过": "modelProbe.reasons.search",
  "经 Chat 桥函数映射的客户端检索、发现工具调用及结果回传已通过": "modelProbe.reasons.chatSearch",
  "已收到完成的 web_search_call 搜索事件": "modelProbe.reasons.webSearch",
  "请求已完成，但未取得原生 web_search 搜索执行证据": "modelProbe.reasons.webSearchUnconfirmed",
  "上游明确拒绝原生 web_search 工具或参数": "modelProbe.reasons.webSearchRejected",
  "上游返回流内错误，无法确认原生 web_search 能力": "modelProbe.reasons.webSearchStreamError",
  "上游未返回完整且可验证的流式响应": "modelProbe.reasons.incompleteStream",
  "模型能力检测总预算或代理发现预算已耗尽": "modelProbe.reasons.discoveryBudget",
  "模型能力检测代理配置或发现失败": "modelProbe.reasons.proxy",
  "模型能力检测认证或权限失败": "modelProbe.reasons.auth",
  "模型能力检测受到上游限流": "modelProbe.reasons.rateLimit",
  "上游明确拒绝本项检测使用的输入或参数": "modelProbe.reasons.rejected",
  "上游拒绝请求，无法确认本项能力": "modelProbe.reasons.requestRejected",
}

export function translateCustomModelProbeReason(t: Translate, reason: string): string {
  return t(Object.hasOwn(reasons, reason) ? reasons[reason]! : "modelProbe.reasons.unknown")
}
