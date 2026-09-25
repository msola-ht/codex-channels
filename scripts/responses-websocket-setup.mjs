import { probeResponsesWebSocket } from "./responses-websocket-probe.mjs";

export async function promptResponsesWebSocket(prompts, input, {output = process.stdout, probe = probeResponsesWebSocket, current = false} = {}) {
  let action = await prompts.select({
    message:"Responses WebSocket 连接方式",
    options:[
      {value:"detect",label:"自动检测（推荐）",hint:"先检测握手和预热，不修改配置；第三方计费以平台为准"},
      {value:"no",label:"关闭，使用 HTTP/SSE"},
      {value:"yes",label:"手动启用",hint:"跳过检测，按平台声明启用"},
    ],
    initialValue:current ? "yes" : "detect",
  });
  while (true) {
    if (prompts.isCancel(action) || action === "back") return undefined;
    if (action === "yes") return true;
    if (action === "no") return false;
    if (action !== "detect" && action !== "generate") throw new Error("WS 检测操作无效");
    if (action === "generate") {
      const confirmed = await prompts.confirm({message:"发送一次极短模型请求验证 WS？可能产生费用，不包含仓库或现有会话内容。",initialValue:false});
      if (prompts.isCancel(confirmed)) return undefined;
      if (!confirmed) { action = "no"; continue; }
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    output.write(`\n正在检测 WS ${action === "generate" ? "模型请求" : "连接及预热"}，最长 15 秒；Ctrl+C 取消。\n`);
    let result;
    try { result = await probe({...input,mode:action === "generate" ? "generate" : "prewarm",signal:controller.signal}); }
    finally { process.removeListener("SIGINT",cancel); }
    if (result.status === "cancelled" || controller.signal.aborted) return undefined;
    output.write(`${result.reason}${result.httpStatus === undefined ? "" : `（HTTP ${result.httpStatus}）`}\n`);
    if (result.connected && result.status === "inconclusive") output.write("WS 握手成功，但请求兼容性尚未确认。\n");
    action = await prompts.select({
      message:"根据检测结果选择后续操作（最终保存时再次确认）",
      options:[
        ...(result.connected && result.status !== "verified" ? [{value:"generate",label:"验证一次模型请求（可能计费）"}] : []),
        {value:"no",label:"关闭 WS，使用 HTTP/SSE"},
        {value:"yes",label:result.status === "verified" ? "启用 WS" : "仍然启用 WS（模型请求未验证）"},
        {value:"detect",label:"重新检测连接及预热"},
      ],
      initialValue:result.status === "verified" ? "yes" : "no",
    });
  }
}
