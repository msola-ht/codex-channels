import { describe,expect,it,vi } from "vitest";
import { promptResponsesWebSocket } from "../scripts/responses-websocket-setup.mjs";
import type { ResponsesWebSocketProbeResult } from "../scripts/responses-websocket-probe.mjs";
const input={baseUrl:"https://example.com/v1",apiKey:"fixture-secret",model:"model"};
function prompts(selects:unknown[],confirmed:unknown=true) {
  return {select:vi.fn(async()=>selects.shift()),confirm:vi.fn(async()=>confirmed),text:vi.fn(),password:vi.fn(),isCancel:(value:unknown)=>typeof value === "symbol"};
}
describe("Responses WS setup",()=>{
  it.each(["yes","no"])("keeps the %s manual path free of network requests",async action=>{
    const probe=vi.fn();
    expect(await promptResponsesWebSocket(prompts([action]),input,{probe})).toBe(action === "yes");
    expect(probe).not.toHaveBeenCalled();
  });
  it("separates prewarm from explicitly confirmed model generation",async()=>{
    const probe=vi.fn().mockResolvedValueOnce({status:"prewarm",connected:true,reason:"预热通过"}).mockResolvedValueOnce({status:"verified",connected:true,reason:"验证成功"});
    const output={write:vi.fn()};
    const ui=prompts(["detect","generate","yes"]);
    expect(await promptResponsesWebSocket(ui,input,{probe,output})).toBe(true);
    expect(probe.mock.calls.map(([options])=>options.mode)).toEqual(["prewarm","generate"]);
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(JSON.stringify(output.write.mock.calls)).not.toContain(input.apiKey);
  });
  it("does not send a model request when the cost confirmation is declined",async()=>{
    const probe=vi.fn(async():Promise<ResponsesWebSocketProbeResult>=>({status:"prewarm",connected:true,reason:"预热通过"}));
    expect(await promptResponsesWebSocket(prompts(["detect","generate"],false),input,{probe,output:{write:vi.fn()}})).toBe(false);
    expect(probe).toHaveBeenCalledOnce();
  });
  it("retries only on explicit choice and can cancel without a saved setting",async()=>{
    const probe=vi.fn().mockResolvedValueOnce({status:"inconclusive",connected:false,reason:"超时"}).mockResolvedValueOnce({status:"cancelled",connected:false,reason:"取消"});
    expect(await promptResponsesWebSocket(prompts(["detect","detect"]),input,{probe,output:{write:vi.fn()}})).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("cleans up the SIGINT listener when the probe throws",async()=>{
    const count=process.listenerCount("SIGINT");
    const probe=vi.fn(async()=>{throw new Error("fixture failure");});
    await expect(promptResponsesWebSocket(prompts(["detect"]),input,{probe,output:{write:vi.fn()}})).rejects.toThrow("fixture failure");
    expect(process.listenerCount("SIGINT")).toBe(count);
  });
});
