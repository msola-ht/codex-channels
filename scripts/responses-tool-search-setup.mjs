import { probeResponsesToolSearch } from "./responses-tool-search-probe.mjs";

export async function promptResponsesToolSearch(prompts, input, {output = process.stdout, probe = probeResponsesToolSearch, current = false} = {}) {
  let action = await prompts.select({
    message:"上游是否支持 Codex 客户端 tool_search（工具按需检索）",
    options:[
      {value:"detect",label:"自动检测（推荐）",hint:"发送一次极短请求验证上游是否接受检索输入项，可能计费"},
      {value:"no",label:"不声明，工具全量下发"},
      {value:"yes",label:"手动声明支持",hint:"跳过检测；上游不支持时模型触发检索会失败"},
    ],
    initialValue:current ? "yes" : "detect",
  });
  while (true) {
    if (prompts.isCancel(action) || action === "back") return undefined;
    if (action === "yes") return true;
    if (action === "no") return false;
    if (action !== "detect") throw new Error("工具检索检测操作无效");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    output.write("\n正在检测工具检索兼容性，最长 15 秒；Ctrl+C 取消。\n");
    let result;
    try { result = await probe({...input, signal: controller.signal}); }
    finally { process.removeListener("SIGINT", cancel); }
    if (result.status === "cancelled" || controller.signal.aborted) return undefined;
    output.write(`${result.reason}${result.httpStatus === undefined ? "" : `（HTTP ${result.httpStatus}）`}\n`);
    action = await prompts.select({
      message:"根据检测结果选择后续操作（最终保存时再次确认）",
      options:[
        {value:"yes",label:result.status === "supported" ? "声明支持 tool_search" : "仍然声明支持（未检测通过）"},
        {value:"no",label:"不声明，工具全量下发"},
        {value:"detect",label:"重新检测"},
      ],
      initialValue:result.status === "supported" ? "yes" : "no",
    });
  }
}
