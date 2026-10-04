import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("confirms successful snapshots, bounds event reads and retries, and cleans up subscriptions", () => {
  const script = String.raw`
    import fs from 'node:fs';
    import ts from 'typescript';
    import assert from 'node:assert/strict';
    import {ManagementRateLimiter} from './scripts/management-access.mjs';
    const source=fs.readFileSync('webui/src/hooks/use-queue-events.ts','utf8').replace(/^import .*$/gm,'').replace(/export (function|interface)/g,'$1');
    const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    const page=new EventTarget(),win=new EventTarget();page.visibilityState='visible';
    const network={onLine:true},slots=[],effects=[],timers=new Map(),watches=[],latest={current:0};
    let si=0,ei=0,clock=100000,id=0,refreshes=0,loading=false,enabled=true,read=null,requested=0,retryOnChange=false,subscribed=true;
    Date.now=()=>clock;
    const useState=initial=>{const i=si++;if(!(i in slots))slots[i]=initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}];};
    const useEffect=(run,deps)=>{const i=ei++,old=effects[i];if(!old||deps.some((v,j)=>v!==old.deps[j]))effects[i]={run,deps,cleanup:old?.cleanup,pending:true};};
    const schedule=(run,ms)=>{const key=++id;timers.set(key,{run,at:clock+ms});return key;};
    const tick=ms=>{clock+=ms;for(const[key,timer]of[...timers])if(timer.at<=clock){timers.delete(key);timer.run();}};
    const watch=(signal,receive)=>new Promise((resolve,reject)=>{watches.push({signal,receive,reject});signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});});
    const hook=new Function('useEffect','useState','watchDeliveryQueue','ApiClientError','document','window','navigator','setTimeout','clearTimeout',code+';return useQueueEvents;')(
      useEffect,useState,watch,class extends Error{},page,win,network,schedule,key=>timers.delete(key));
    const refresh=()=>{refreshes++;loading=true;requested=latest.current;queueMicrotask(()=>render());};
    const render=()=>{si=ei=0;const status=hook(refresh,loading,enabled,latest,read,subscribed?watch:null,retryOnChange);for(const e of effects)if(e.pending){e.cleanup?.();e.pending=false;e.cleanup=e.run();}return status;};
    const settle=()=>new Promise(resolve=>setImmediate(resolve));
    const push=()=>{watches.at(-1).receive({type:'changed'});render();};
    const success=()=>{loading=false;read={confirmed:requested,completedAt:clock,failed:false,failures:0,retryable:false,retryAt:0};render();};
    const fail=(limited=false,retryable=true)=>{loading=false;const failures=(read?.failures??0)+1;read={confirmed:read?.confirmed??0,attempted:requested,completedAt:clock,failed:true,failures,retryable,retryAt:clock+(limited?60000:Math.min(8000,2000*2**(failures-1)))};return render();};
    render();push();tick(250);await settle();assert.equal(refreshes,1);
    push();success(); // A change during the read must survive that read's success.
    tick(1999);assert.equal(refreshes,1);tick(1);await settle();assert.equal(refreshes,2);success();
    const limiter=new ManagementRateLimiter({now:()=>clock});const baseline=refreshes;
    for(let i=0;i<600;i++){
      push();tick(100);await settle();
      if(loading){limiter.consume({principalId:'queue',category:'read'});limiter.consume({principalId:'queue',category:'read'});success();}
    }
    assert(refreshes-baseline<=30);assert(refreshes-baseline>=28);
    enabled=false;push();tick(10000);assert(!loading);enabled=true;render();tick(250);await settle();assert(loading);success();
    push();tick(2000);await settle();assert.equal(fail(),'retrying');const failedAt=refreshes;
    tick(1999);assert.equal(refreshes,failedAt);tick(1);await settle();assert.equal(refreshes,failedAt+1);success();
    const recovered=refreshes;tick(60000);assert.equal(refreshes,recovered); // No idle polling after recovery.
    push();tick(250);await settle();fail(true);const limitedAt=refreshes;
    for(let i=0;i<59;i++){if(i===0){watches.at(-1).reject(new Error('reconnect during cooldown'));await settle();render();tick(1000);await settle();push();}else{push();tick(1000);await settle();}assert.equal(refreshes,limitedAt);}
    tick(1000);await settle();assert.equal(refreshes,limitedAt+1);success();
    push();tick(2000);await settle();
    for(let attempt=1;attempt<=4;attempt++){
      const status=fail();if(attempt===4){assert.equal(status,'stale');break;}
      tick(2000*2**(attempt-1));await settle();assert(loading);
    }
    const exhausted=refreshes;push();tick(60000);assert.equal(refreshes,exhausted);
    refresh();await settle();success();assert.equal(render(),'live'); // Manual success resets failure budget.
    push();tick(2000);await settle();assert.equal(fail(false,false),'stale');const permanent=refreshes;push();tick(60000);assert.equal(refreshes,permanent);
    refresh();await settle();success();
    retryOnChange=true;push();tick(2000);await settle();fail(false,false);
    const missing=refreshes;tick(60000);assert.equal(refreshes,missing);
    push();tick(250);await settle();assert.equal(refreshes,missing+1);success();
    subscribed=false;enabled=false;render();await settle();render();assert(watches.at(-1).signal.aborted);
    const detached=watches.length;tick(60000);assert.equal(watches.length,detached);
    subscribed=true;enabled=true;render();push();tick(250);await settle();success();
    page.visibilityState='hidden';page.dispatchEvent(new Event('visibilitychange'));await settle();render();assert(watches.at(-1).signal.aborted);
    const before=watches.length;tick(60000);assert.equal(watches.length,before);
    page.visibilityState='visible';page.dispatchEvent(new Event('visibilitychange'));assert.equal(watches.length,before+1);
    push();tick(250);await settle();success();
    watches.at(-1).reject(new Error('lost'));await settle();assert.equal(render(),'reconnecting');tick(1000);await settle();assert.equal(watches.length,before+2);
    const disconnectedReads=refreshes;tick(1000);await settle();assert.equal(refreshes,disconnectedReads+1);success();
    const offlineReads=refreshes;
    for(let i=0;i<3;i++){watches.at(-1).reject(new Error('still down'));await settle();render();tick(30000);await settle();assert.equal(refreshes,offlineReads);}
    network.onLine=false;win.dispatchEvent(new Event('offline'));await settle();render();assert(watches.at(-1).signal.aborted);
    network.onLine=true;win.dispatchEvent(new Event('online'));const count=watches.length;
    for(const e of effects)e.cleanup?.();await settle();assert(watches.at(-1).signal.aborted);
    tick(60000);page.dispatchEvent(new Event('visibilitychange'));win.dispatchEvent(new Event('online'));assert.equal(watches.length,count);assert.equal(timers.size,0);
  `;
  expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).not.toThrow();
});

it("reads fragmented SSE with header authentication and rejects malformed or expired streams", () => {
  const script = String.raw`
    import {createServer} from 'vite';
    import assert from 'node:assert/strict';
    const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent'});
    try {
      const {watchDeliveryQueue,watchRelayQueue,watchRequestMetrics,watchAccountSnapshots,watchTraffic,onUnauthorized}=await server.ssrLoadModule('/src/lib/api.ts');
      globalThis.localStorage={getItem:()=> 'private-token'};
      const encoder=new TextEncoder();
      const response=parts=>new Response(new ReadableStream({start(controller){for(const part of parts)controller.enqueue(encoder.encode(part));controller.close();}}),{headers:{'content-type':'text/event-stream'}});
      globalThis.fetch=async(url,init)=>{assert.equal(url,'/api/v1/traffic/events?label=relay.responses&session=batch&detail=1');assert.equal(init.headers.get('authorization'),'Bearer private-token');return response(['data: {"type":"changed"}\n\n']);};
      await assert.rejects(watchTraffic({label:'relay.responses',session:'batch',detail:true},new AbortController().signal,()=>{}),/disconnected/);
      const received=[];
      globalThis.fetch=async(url,init)=>{
        assert.equal(url,'/api/v1/management/delivery/events');assert.equal(init.headers.get('authorization'),'Bearer private-token');
        return response(['data: {"ty','pe":"changed"}\n\n','data: {"type":"heartbeat"}\n\ndata: {"type":"changed"}\n\n']);
      };
      await assert.rejects(watchDeliveryQueue(new AbortController().signal,event=>received.push(event.type)),/disconnected/);
      assert.deepEqual(received,['changed','heartbeat','changed']);
      const combined=[];
      globalThis.fetch=async()=>response(['data: {"type":"changed"}\n\n'.repeat(200)]);
      await assert.rejects(watchDeliveryQueue(new AbortController().signal,event=>combined.push(event)),/disconnected/);
      assert.equal(combined.length,200);
      const prefix='data: {"type":"changed"}';
      const exact=prefix+' '.repeat(4096-prefix.length);
      globalThis.fetch=async()=>response([exact+'\n','\n']);
      const boundary=[];
      await assert.rejects(watchDeliveryQueue(new AbortController().signal,event=>boundary.push(event)),/disconnected/);
      assert.equal(boundary.length,1);
      for(const parts of [[exact+' \n\n'], [exact,'  ']]) {
        globalThis.fetch=async()=>response(parts);
        await assert.rejects(watchDeliveryQueue(new AbortController().signal,()=>assert.fail('oversized frame escaped')),/frame too large/);
      }
      globalThis.fetch=async(url,init)=>{assert.equal(url,'/api/v1/management/relay/queue/events');assert.equal(init.headers.get('authorization'),'Bearer private-token');return response(['data: {"type":"changed"}\n\n']);};
      await assert.rejects(watchRelayQueue(new AbortController().signal,()=>{}),/disconnected/);
      globalThis.fetch=async(url,init)=>{assert.equal(url,'/api/v1/metrics/events');assert.equal(init.headers.get('authorization'),'Bearer private-token');return response(['data: {"type":"changed"}\n\n']);};
      await assert.rejects(watchRequestMetrics(new AbortController().signal,()=>{}),/disconnected/);
      globalThis.fetch=async(url,init)=>{assert.equal(url,'/api/v1/accounts/events');assert.equal(init.headers.get('authorization'),'Bearer private-token');return response(['data: {"type":"changed"}\n\n']);};
      await assert.rejects(watchAccountSnapshots(new AbortController().signal,()=>{}),/disconnected/);
      for(const value of ['data: {"type":"unknown"}\n\n','data: {"type":"changed","secret":true}\n\n','x'.repeat(5000)]) {
        globalThis.fetch=async()=>response([value]);
        await assert.rejects(watchDeliveryQueue(new AbortController().signal,()=>assert.fail('invalid event escaped')));
      }
      let unauthorized=0;onUnauthorized(()=>unauthorized++);
      globalThis.fetch=async()=>new Response('',{status:401});
      await assert.rejects(watchDeliveryQueue(new AbortController().signal,()=>{}),error=>error.status===401);
      assert.equal(unauthorized,1);
      const abort=new AbortController();
      let cancelled=false;
      globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(encoder.encode('data: {"type":"changed"}\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
      // A throwing subscriber still releases the stream and its idle timeout.
      await assert.rejects(watchDeliveryQueue(abort.signal,()=>{throw new Error('stop');}),/stop/);
      assert(cancelled);
    } finally {await server.close();}
  `;
  expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })).not.toThrow();
});

it.each(["delivery", "relay"])("records %s snapshot outcomes without acknowledging later notifications or cancelled reads", kind => {
  const script = String.raw`
    import fs from 'node:fs';import ts from 'typescript';import assert from 'node:assert/strict';
    const source=fs.readFileSync('webui/src/hooks/use-delivery-queue.ts','utf8').replace(/^import .*$/gm,'').replace(/export (function|interface)/g,'$1');
    const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    const slots=[],refs=[],pending=[];let si=0,ri=0,options,captured;
    const useState=initial=>{const i=si++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];};
    const useRef=initial=>refs[ri++]??(refs[ri-1]={current:initial});
    class ApiClientError extends Error{constructor(message,status=message,code){super('failure');this.status=status;this.code=code;}}
    const sharedSource=fs.readFileSync('webui/src/hooks/use-queue-events.ts','utf8').replace(/^import .*$/gm,'').replace(/export (function|interface)/g,'$1');
    const sharedCode=ts.transpileModule(sharedSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    const useQueueSnapshot=new Function('useState','useRef','useCallback','ApiClientError',sharedCode+';return useQueueSnapshot;')(useState,useRef,fn=>fn,ApiClientError);
    const hook=new Function('useState','useRef','useCallback','useManagementConfirmedMutation','useQueueEvents','useQueueSnapshot','watchDeliveryQueue','fetchDeliveryQueue','ApiClientError','previewDeliveryBatch','applyDeliveryBatch',code+';return useDeliveryQueue;')(
      useState,useRef,fn=>fn,value=>{options=value;return{};},(refetch,loading,enabled,latest,read)=>{captured={latest,read};},useQueueSnapshot,()=>{},()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),ApiClientError,()=>{},()=>{});
    const render=()=>{si=ri=0;hook(0,'all');};
    Date.now=()=>1000;render();captured.latest.current=5;
    const first=options.load();captured.latest.current=10;pending.shift().resolve({records:[]});await first;render();
    assert.equal(captured.read.confirmed,5);assert.equal(captured.read.failed,false);
    const failure=async(error)=>{const task=options.load().catch(()=>{});pending.shift().reject(error);await task;render();};
    await failure(new ApiClientError(429));assert.equal(captured.read.retryAt,61000);assert.equal(captured.read.confirmed,5);assert.equal(captured.read.retryable,true);
    await failure(new ApiClientError(503));assert.equal(captured.read.retryAt,5000);assert.equal(captured.read.failures,2);
    await failure(new TypeError('offline'));assert.equal(captured.read.retryAt,9000);assert.equal(captured.read.retryable,true);
    await failure(Object.assign(new Error('timeout'),{name:'TimeoutError'}));assert.equal(captured.read.retryable,true);
    await failure(new ApiClientError(401));assert.equal(captured.read.retryable,false);
    const previous=captured.read,abort=new AbortController();const cancelled=options.load(abort.signal).catch(()=>{});abort.abort();pending.shift().reject(new TypeError('aborted'));await cancelled;render();assert.equal(captured.read,previous);
    const success=options.load();pending.shift().resolve({records:[]});await success;render();assert.equal(captured.read.confirmed,10);assert.equal(captured.read.failures,0);assert.equal(captured.read.failed,false);
  `;
  let selected = kind === "delivery" ? script : script.replaceAll("use-delivery-queue", "use-relay-queue")
    .replaceAll("useDeliveryQueue", "useRelayQueue").replaceAll("fetchDeliveryQueue", "fetchRelayQueue")
    .replaceAll("watchDeliveryQueue", "watchRelayQueue").replaceAll("useManagementConfirmedMutation", "useApi")
    .replace("options=value", "options={load:value}");
  if (kind === "relay") selected += String.raw`
    captured.latest.current=12;
    for(let attempt=1;attempt<=4;attempt++) {
      const task=options.load();pending.shift().resolve({state:'unknown'});
      await assert.rejects(task,error=>error.code==='relay_queue_unconfirmed' && error.status===503);render();
      assert.equal(captured.read.confirmed,10);assert.equal(captured.read.failed,true);
      assert.equal(captured.read.retryable,true);assert.equal(captured.read.failures,attempt);
    }
    const last=captured.read,abortUnknown=new AbortController();
    const cancelledUnknown=options.load(abortUnknown.signal);abortUnknown.abort();pending.shift().resolve({state:'unknown'});
    await assert.rejects(cancelledUnknown);render();assert.equal(captured.read,last);
    const stopped=options.load();pending.shift().resolve({state:'stopped'});await stopped;render();
    assert.equal(captured.read.confirmed,12);assert.equal(captured.read.failed,false);assert.equal(captured.read.failures,0);
    const empty=options.load();pending.shift().resolve({state:'running',requests:[]});await empty;render();
    assert.equal(captured.read.failed,false);assert.equal(captured.read.failures,0);
  `;
  expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", selected], { encoding: "utf8" })).not.toThrow();
});
