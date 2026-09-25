import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { probeResponsesWebSocket } from "../scripts/responses-websocket-probe.mjs";

async function fixture(run: (options: {baseUrl:string; environment:NodeJS.ProcessEnv}, server: WebSocketServer, http: ReturnType<typeof createServer>) => Promise<void>) {
  const root=mkdtempSync(join(tmpdir(),"ws-probe-"));
  const http=createServer();
  const server=new WebSocketServer({noServer:true});
  http.on("upgrade",(request,socket,head)=>server.handleUpgrade(request,socket,head,ws=>server.emit("connection",ws,request)));
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  const address=http.address();
  if(!address || typeof address === "string") throw new Error("missing address");
  try { await run({baseUrl:`http://127.0.0.1:${address.port}/v1`,environment:{CODEX_HOME:root,NO_PROXY:"127.0.0.1"}},server,http); }
  finally {
    for(const client of server.clients) client.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await new Promise<void>(resolve=>http.close(()=>resolve()));
    rmSync(root,{recursive:true,force:true});
  }
}
const input={apiKey:"fixture-secret",model:"vendor/flash",reasoningEffort:"high"};
describe("Responses WS probe",()=>{
  it.each(["prewarm","generate"] as const)("verifies %s with the pinned wire request and no HTTP fallback",async mode=>{
    await fixture(async(options,server)=>{
      server.on("connection",(socket,request)=>{
        expect(request.url).toBe("/v1/responses");
        expect(request.headers.authorization).toBe("Bearer fixture-secret");
        expect(request.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
        socket.on("message",data=>{
          const payload=JSON.parse(data.toString());
          expect(payload).toMatchObject({type:"response.create",model:input.model,reasoning:{effort:"high"},store:false});
          expect(payload.generate).toBe(mode === "prewarm" ? false : undefined);
          expect(payload.input).toHaveLength(mode === "prewarm" ? 0 : 1);
          socket.send(JSON.stringify({type:"response.completed",response:{id:"r1",status:"completed",model:input.model,output:mode === "prewarm" ? [] : [{type:"message",role:"assistant",content:[{type:"output_text",text:"OK"}]}]}}));
        });
      });
      const result=await probeResponsesWebSocket({...input,...options,mode});
      expect(result.status).toBe(mode === "prewarm" ? "prewarm" : "verified");
      expect(result.connected).toBe(true);
      expect(JSON.stringify(result)).not.toContain(input.apiKey);
    });
  });
  it.each(["item","delta"])("accepts %s text followed by a minimal Codex completion event",async kind=>{
    await fixture(async(options,server)=>{
      server.on("connection",socket=>socket.on("message",()=>{
        socket.send(JSON.stringify(kind === "item"
          ? {type:"response.output_item.done",item:{type:"message",role:"assistant",content:[{type:"output_text",text:"OK"}]}}
          : {type:"response.output_text.delta",delta:"OK"}));
        socket.send(JSON.stringify({type:"response.completed",response:{id:"r1"}}));
      }));
      expect(await probeResponsesWebSocket({...input,...options,mode:"generate"})).toMatchObject({status:"verified"});
    });
  });
  it("accepts a minimal prewarm completion without generated text",async()=>{
    await fixture(async(options,server)=>{
      server.on("connection",socket=>socket.on("message",()=>socket.send(JSON.stringify({type:"response.completed",response:{id:"r1"}}))));
      expect(await probeResponsesWebSocket({...input,...options})).toMatchObject({status:"prewarm"});
    });
  });
  it.each(["response.failed","response.incomplete","close"])("does not accept text without successful completion: %s",async terminal=>{
    await fixture(async(options,server)=>{
      server.on("connection",socket=>socket.on("message",()=>{
        socket.send(JSON.stringify({type:"response.output_text.delta",delta:"OK"}));
        if(terminal === "close") socket.close();
        else socket.send(JSON.stringify({type:terminal,response:{id:"r1"}}));
      }));
      expect(await probeResponsesWebSocket({...input,...options,mode:"generate"})).toMatchObject({status:"inconclusive"});
    });
  });
  it.each([401,403,404,429,302])("reports HTTP %s without following redirects or leaking response content",async status=>{
    await fixture(async(options,_server,http)=>{
      http.removeAllListeners("upgrade");
      http.on("upgrade",(_request,socket)=>socket.end(`HTTP/1.1 ${status} Failed\r\nLocation: https://invalid.example/secret\r\nContent-Length: 14\r\nConnection: close\r\n\r\nfixture-secret`));
      const result=await probeResponsesWebSocket({...input,...options});
      expect(result).toMatchObject({status:"inconclusive",connected:false,httpStatus:status});
      expect(JSON.stringify(result)).not.toContain("secret");
    });
  });
  it.each([
    {type:"error",error:{message:"fixture-secret"}},
    {type:"response.completed",response:{id:"r1",status:"completed",output:[]}},
    {type:"response.completed",response:{id:"r1",status:"completed",model:"wrong"}},
  ])("does not treat failed or incomplete model output as verified",async event=>{
    await fixture(async(options,server)=>{
      server.on("connection",socket=>socket.on("message",()=>socket.send(JSON.stringify(event))));
      const result=await probeResponsesWebSocket({...input,...options,mode:"generate"});
      expect(result).toMatchObject({status:"inconclusive",connected:true});
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
    });
  });
  it("bounds a silent connection and supports cancellation",async()=>{
    await fixture(async(options,server)=>{
      expect(await probeResponsesWebSocket({...input,...options,timeoutMs:50})).toMatchObject({status:"inconclusive"});
      const controller=new AbortController();
      server.once("connection",()=>controller.abort());
      expect(await probeResponsesWebSocket({...input,...options,signal:controller.signal})).toMatchObject({status:"cancelled"});
    });
  });
});
