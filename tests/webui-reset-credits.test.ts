import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayAccountRefreshServer } from "../runtime/gateway-account-refresh.mjs";
import { OpenAiResetCreditService } from "../src/application/index.js";
import { cleanupWebuiTestFixtures, createWebuiTestFixture, startWebuiTestServer, type WebuiTestServer } from "./webui-server-test-fixture.js";
const roots: string[] = []; const servers: WebuiTestServer[] = [];
afterEach(async () => cleanupWebuiTestFixtures(servers, roots));
describe("WebUI reset credit confirmation over real IPC", () => {
  it.each(["reset", "unknown", "cancel", "audit-failure"])("requires origin and one-use confirmation, preserving %s outcome", async outcome => {
    const fixture = createWebuiTestFixture(roots);
    const consume = vi.fn(async () => { if (outcome === "unknown") throw new Error("private account response"); return "reset" as const; });
    const service = new OpenAiResetCreditService({ readResetCredits: async () => ({ accountId: "account", availableCount: "1",
      credits: [{ id: "credit", title: "Fixture", description: "Scope", expiresAt: null }] }), consumeResetCredit: consume }, async () => {});
    const ipc = new GatewayAccountRefreshServer(join(fixture.home, "config.toml"), async () => true,
      async (request, signal) => {
        if (request.method === "reset/cancel") { service.cancel(request.attemptId); return { cancelled: true }; }
        return request.method === "reset/list" ? service.list(signal)
          : request.method === "reset/preview" ? service.preview(request.creditId, signal) : service.consume(request.attemptId, signal);
      });
    await ipc.start();
    try {
      const managementOrigin = "http://127.0.0.1:0";
      const { origin } = await startWebuiTestServer(servers, fixture.environment, undefined, { managementOrigin, token: "fixture-token" });
      const base = `${origin}/api/v1/management/accounts/openai/reset-credits`;
      const post = (path: string, body: unknown, source = managementOrigin) => fetch(`${base}/${path}`, {
        method: "POST", headers: { authorization: "Bearer fixture-token", origin: source, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect((await fetch(base)).status).toBe(401);
      expect((await fetch(base, { headers: { authorization: "Bearer fixture-token" } })).status).toBe(200);
      const forbidden = await post("preview", { creditId: "credit" }, "https://attacker.invalid");
      expect(forbidden.status).toBe(403);
      expect((await post("consume", {})).status).toBe(400);
      if (outcome === "cancel") {
      const toCancel = await (await post("preview", { creditId: "credit" })).json() as { preview: { attemptId: string }; confirmationToken: string };
      const cancelInput = { attemptId: toCancel.preview.attemptId, confirmationToken: toCancel.confirmationToken };
      expect((await post("cancel", cancelInput, "https://attacker.invalid")).status).toBe(403);
      expect((await post("cancel", { ...cancelInput, confirmationToken: "wrong" })).status).toBe(409);
      expect((await post("cancel", cancelInput)).status).toBe(200);
      expect((await post("consume", cancelInput)).status).toBe(409);
      await expect(service.consume(cancelInput.attemptId)).rejects.toMatchObject({ code: "reset_stale" });
      expect(consume).not.toHaveBeenCalled();
      return;
      }
      const response = await post("preview", { creditId: "credit" });
      expect(response.status).toBe(200);
      const preview = await response.json() as { preview: { attemptId: string }; confirmationToken: string };
      expect(consume).not.toHaveBeenCalled();
      const input = { attemptId: preview.preview.attemptId, confirmationToken: preview.confirmationToken };
      if (outcome === "audit-failure") {
        mkdirSync(join(fixture.home, "management-audit.jsonl"));
        const failed = await post("consume", input);
        expect(failed.status).toBe(500);
        expect(await failed.json()).toMatchObject({ error: { code: "management_audit_unavailable" } });
        await expect(service.consume(input.attemptId)).rejects.toMatchObject({ code: "reset_stale" });
        expect(consume).not.toHaveBeenCalled();
        return;
      }
      const result = await post("consume", input);
      expect(result.status).toBe(outcome === "reset" ? 200 : 503);
      const body = await result.json();
      expect(body).toMatchObject(outcome === "reset" ? { outcome: "reset", refreshed: true, auditRecorded: true } : { error: { code: "reset_unknown" } });
      expect(JSON.stringify(body)).not.toContain("private account response");
      expect((await post("consume", input)).status).toBe(409);
      expect(consume).toHaveBeenCalledOnce();
    } finally { await ipc.close(); }
  });
});


it("releases WebUI previews on cancel or close and serializes competing clicks", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'reset-cancel-fixture', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/overview/reset-credit-action.tsx')) return code.replace('function ResetCreditDialog(', 'export function ResetCreditDialog(');
        if (id.endsWith('/hooks/use-management-confirmed-mutation.ts')) return 'export function useManagementConfirmedMutation() { return globalThis.management; }';
        if (id.endsWith('/hooks/use-translation.ts')) return 'export function useTranslation() { return {t:key=>key}; }';
        if (id.endsWith('/ui/button.tsx')) return 'export function Button(props) { globalThis.buttons.push(props); return null; }';
        if (id.endsWith('/ui/dialog.tsx')) return 'export function Dialog(props) { globalThis.dialog = props; return props.children; } export const DialogContent = p=>p.children; export const DialogDescription = p=>p.children; export const DialogFooter = p=>p.children; export const DialogHeader = p=>p.children; export const DialogTitle = p=>p.children;';
      }
    }] });
    try {
      const { ResetCreditDialog } = await server.ssrLoadModule('/src/components/overview/reset-credit-action.tsx');
      const requests=[]; let cancelled=0, consumed=0, closed=0;
      globalThis.fetch=async (url, init)=>{requests.push({url, body:JSON.parse(init.body)}); return new Response(JSON.stringify({cancelled:true}), {status:200});};
      globalThis.management={busy:false,loading:false,error:null,actionError:null,data:null,
        pendingPreview:{preview:{attemptId:'attempt',credit:{title:'Title',description:'Scope',expiresAt:null}},confirmationToken:'token'},
        cancel:()=>{cancelled++},confirm:async()=>{consumed++;return null;}};
      const render=()=>{globalThis.buttons=[];renderToStaticMarkup(h(ResetCreditDialog,{onClose:()=>{closed++},onChanged:()=>{}}));};
      render();
      const cancel=globalThis.buttons.find(button=>button.children==='resetCredits.cancel');
      cancel.onClick(); cancel.onClick();
      globalThis.buttons.find(button=>Array.isArray(button.children)&&button.children.includes('resetCredits.confirm')).onClick();
      await new Promise(resolve=>setImmediate(resolve));
      render(); globalThis.dialog.onOpenChange(false);
      await new Promise(resolve=>setImmediate(resolve));
      console.log(JSON.stringify({requests,cancelled,consumed,closed}));
    } finally { await server.close(); }
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as { requests: Array<{ url: string; body: unknown }>; cancelled: number; consumed: number; closed: number };
  expect(result.requests).toHaveLength(2);
  for (const request of result.requests) {
    expect(request.url).toMatch(/reset-credits\/cancel$/u);
    expect(request.body).toEqual({ attemptId: "attempt", confirmationToken: "token" });
  }
  expect(result.cancelled).toBe(2);
  expect(result.consumed).toBe(0);
  expect(result.closed).toBe(1);
});


it("classifies uncertain HTTP consume responses without retrying or masking controlled rejections", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'reset-result-fixture', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/overview/reset-credit-action.tsx')) return code.replace('function ResetCreditDialog(', 'export function ResetCreditDialog(');
        if (id.endsWith('/hooks/use-management-confirmed-mutation.ts')) return 'export function useManagementConfirmedMutation(options) { globalThis.options = options; return {busy:false,loading:false,error:null,pendingPreview:null}; }';
        if (id.endsWith('/hooks/use-translation.ts')) return 'export function useTranslation() { return {t:key=>key}; }';
      }
    }] });
    try {
      const { ResetCreditDialog } = await server.ssrLoadModule('/src/components/overview/reset-credit-action.tsx');
      renderToStaticMarkup(h(ResetCreditDialog,{onClose(){},onChanged(){}}));
      let calls=0;
      const results={};
      const apply=()=>globalThis.options.apply({creditId:'credit'},'token',undefined,{attemptId:'attempt'}).then(value=>value, error=>error.code);
      const scenarios={
        network:()=>{throw new TypeError('private network detail');},
        timeout:()=>{throw new DOMException('private timeout detail','TimeoutError');},
        badGateway:()=>new Response('Bad Gateway',{status:502}),
        gatewayTimeout:()=>new Response('<html>Timeout</html>',{status:504}),
        malformedSuccess:()=>new Response('{',{status:200}),
        unknownStructured:()=>new Response(JSON.stringify({error:{code:'unexpected_proxy_error'}}),{status:503}),
        unknownClientError:()=>new Response('Request timeout',{status:408}),
      };
      for (const [name, response] of Object.entries(scenarios)) {
        globalThis.fetch=async()=>{calls++;return response();}; results[name]=await apply();
      }
      for (const [code,status] of [['reset_stale',409],['reset_busy',409],['reset_unavailable',503],['reset_unknown',503],
        ['management.confirmation-invalid',409],['management_audit_unavailable',500],['unauthorized',401],['management.rate-limited',429],['management.origin-invalid',403],['invalid_request',400]]) {
        globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{code,message:'Controlled rejection'}}),{status});};
        results[code]=await apply();
      }
      globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({outcome:'reset',refreshed:false,auditRecorded:false}),{status:200});};
      results.success=await apply();
      console.log(JSON.stringify({results,calls}));
    } finally { await server.close(); }
  `;
  const { results, calls } = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as { results: Record<string, unknown>; calls: number };
  for (const name of ["network", "timeout", "badGateway", "gatewayTimeout", "malformedSuccess", "unknownStructured", "unknownClientError"]) {
    expect(results[name]).toBe("reset_unknown");
  }
  for (const code of ["reset_stale", "reset_busy", "reset_unavailable", "reset_unknown", "management.confirmation-invalid",
    "management_audit_unavailable", "unauthorized", "management.rate-limited", "management.origin-invalid", "invalid_request"]) {
    expect(results[code]).toBe(code);
  }
  expect(results.success).toEqual({ outcome: "reset", refreshed: false, auditRecorded: false });
  expect(calls).toBe(Object.keys(results).length);
});
