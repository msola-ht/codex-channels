import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeliveryJournal } from "../src/delivery/index.js";

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "delivery-faults-")); roots.push(root); return root; };
const moduleUrl = (path: string) => JSON.stringify(new URL(`../${path}`, import.meta.url).href);
const workerUrl = new URL("../dist/delivery/worker.js", import.meta.url);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.skipIf(process.platform === "win32").each([
  "before-submit", "after-submit", "before-platform", "after-started", "after-platform", "partial-confirmed", "before-ack", "after-ack",
])("retains and fences output across SIGKILL at %s", async (cut) => {
  const root = fixture();
  const directory = join(root, "journal");
  const script = join(root, "crash.mjs");
  const text = "x".repeat(6_000) + "END";
  writeFileSync(script, `
    import { appendFileSync } from 'node:fs';
    import { DeliveryJournal, DeliveryCoordinator } from ${moduleUrl("dist/delivery/index.js")};
    import { FeishuOutbox } from ${moduleUrl("dist/surfaces/feishu/outbox.js")};
    import pino from ${moduleUrl("node_modules/pino/pino.js")};
    const [directory, cut, log] = process.argv.slice(2);
    const stop = (point) => { if (cut === point) process.kill(process.pid, 'SIGKILL'); };
    const journal = new DeliveryJournal(directory);
    await journal.ready;
    stop('before-submit');
    const event = { type: 'text.completed', target: { surface: 'feishu', accountId: 'default', conversationId: 'chat' },
      threadId: 'thread', turnId: 'turn', itemId: 'item', phase: 'final_answer', text: ${JSON.stringify(text)} };
    await journal.submit({ id: 'first', account: 'account', conversation: 'chat', payload: JSON.stringify(event) });
    await journal.submit({ id: 'second', account: 'account', conversation: 'chat', payload: 'second' });
    await journal.submit({ id: 'independent', account: 'other', conversation: 'other', payload: 'other' });
    stop('after-submit');
    const send = async () => { appendFileSync(log, 'sent\\n'); stop('after-platform'); return 'message'; };
    const outbox = new FeishuOutbox('default', {
      sendText: send, sendPost: send, sendMarkdownCard: send, sendCard: send, updateCard: send,
      createStreamingCard: async () => ({ cardId: 'card', messageId: 'message' }),
      updateStreamingCard: send, finishStreamingCard: send,
    }, pino({ level: 'silent' }));
    const ack = journal.acknowledge.bind(journal);
    journal.acknowledge = async (id) => { stop('before-ack'); const result = await ack(id); stop('after-ack'); return result; };
    const coordinator = new DeliveryCoordinator(journal, {
      accounts: () => ['account'], authorized: () => true, concurrency: 1, fault: () => {},
      deliver: async (record, signal) => {
        stop('before-platform');
        await outbox.deliver(JSON.parse(record.payload), signal, async (checkpoint) => {
          await journal.checkpoint(record.id, checkpoint);
          if (checkpoint.state === 'started') stop('after-started');
          if (checkpoint.state === 'confirmed') stop('partial-confirmed');
        });
      },
    });
    await coordinator.start();
  `);
  const platformLog = join(root, "platform.log");
  writeFileSync(platformLog, "");
  const child = spawnSync(process.execPath, [script, directory, cut, platformLog], { timeout: 15_000, encoding: "utf8" });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.signal, child.stderr).toBe("SIGKILL");
  const sent = readFileSync(platformLog, "utf8").split("\n").filter(Boolean).length;
  expect(sent).toBe(["before-ack", "after-ack"].includes(cut) ? 2 : ["after-platform", "partial-confirmed"].includes(cut) ? 1 : 0);
  const journal = new DeliveryJournal(directory, { workerUrl });
  try {
    await journal.ready;
    if (cut === "before-submit") {
      expect(await journal.summary()).toMatchObject({ records: 0 });
      return;
    }
    const uncertain = !["after-submit", "after-ack"].includes(cut);
    expect(await journal.summary()).toMatchObject({ records: cut === "after-ack" ? 2 : 3, uncertain: uncertain ? 1 : 0 });
    expect(await journal.next()).toMatchObject({ id: uncertain ? "independent" : cut === "after-ack" ? "second" : "first" });
    if (cut !== "after-ack") {
      const row = (await journal.list()).find((entry) => entry.id === "first")!;
      expect(row.progress.map((entry) => entry.state)).toEqual(cut === "before-ack"
        ? ["started", "confirmed", "started", "confirmed"] : cut === "partial-confirmed"
        ? ["started", "confirmed"] : ["after-started", "after-platform"].includes(cut) ? ["started"] : []);
      if (uncertain) expect(await journal.resolve("first", "retry")).toBe(true);
      const recovered = await journal.next();
      expect(JSON.parse(recovered!.payload)).toMatchObject({ text });
    }
  } finally { await journal.close(); }
});

it("bounds persistent backlog under sustained new conversations and a stalled platform", () => {
  const root = fixture();
  const script = join(root, "pressure.mjs");
  writeFileSync(script, `
    import { statSync } from 'node:fs';
    import { join } from 'node:path';
    import { DeliveryJournal, DeliveryCoordinator } from ${moduleUrl("dist/delivery/index.js")};
    const directory = process.argv[2];
    const journal = new DeliveryJournal(directory);
    let started = 0, peakActive = 0, active = 0, rejected = 0, peakMailbox = 0, peakMailboxBytes = 0;
    const unexpectedFaults = [];
    const coordinator = new DeliveryCoordinator(journal, {
      accounts: () => ['a0', 'a1', 'a2', 'a3'], authorized: () => true,
      deliver: async (_record, signal) => {
        started++; active++; peakActive = Math.max(peakActive, active);
        try { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); }
        finally { active--; }
      },
      fault: (code) => { if (code === 'capacity' || code === 'account-capacity') rejected++; else if (code !== 'delivery-uncertain') unexpectedFaults.push(code); },
    });
    await coordinator.start();
    global.gc();
    const baseline = process.memoryUsage();
    const samples = [];
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    for (let batch = 0; batch < 256; batch++) {
      await Promise.all(Array.from({ length: 32 }, (_, offset) => {
        const id = batch * 32 + offset;
        const task = coordinator.submit({ id: String(id), account: 'a' + id % 4, conversation: 'chat-' + id,
          payload: String(id).padEnd(4096, 'x') });
        peakMailbox = Math.max(peakMailbox, Reflect.get(journal, 'pending').size);
        peakMailboxBytes = Math.max(peakMailboxBytes, Reflect.get(journal, 'bytes'));
        return task;
      }));
      if (batch % 32 === 31) {
        global.gc();
        samples.push({ ...process.memoryUsage(), ...(await journal.summary()),
          disk: statSync(join(directory, 'outbox.sqlite3')).size });
      }
    }
    const missingRejected = !coordinator.hasOutstanding('chat-8191');
    const paused = !coordinator.acceptsExecution('a0');
    const closeStart = performance.now();
    await coordinator.close();
    clearInterval(timer);
    console.log(JSON.stringify({ baseline, samples, rejected, unexpectedFaults, started, peakActive, peakMailbox, peakMailboxBytes, missingRejected, paused, ticks, closeMs: performance.now() - closeStart }));
  `);
  const child = spawnSync(process.execPath, ["--expose-gc", script, join(root, "journal")], { timeout: 45_000, encoding: "utf8" });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as {
    baseline: { rss: number; heapUsed: number }; samples: Array<{ rss: number; heapUsed: number; records: number; bytes: number; disk: number }>;
    rejected: number; unexpectedFaults: string[]; started: number; peakActive: number; peakMailbox: number; peakMailboxBytes: number; missingRejected: boolean; paused: boolean; ticks: number; closeMs: number;
  };
  expect(result.peakActive).toBe(8);
  expect(result.started).toBe(8);
  expect(result.peakMailbox).toBeLessThanOrEqual(160);
  expect(result.peakMailboxBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(result.rejected).toBeGreaterThan(4_000);
  expect(result.unexpectedFaults).toEqual([]);
  expect(result.missingRejected).toBe(true);
  expect(result.paused).toBe(true);
  expect(result.ticks).toBeGreaterThan(10);
  expect(result.closeMs).toBeLessThan(6_000);
  const tail = result.samples.slice(-4);
  expect(new Set(tail.map((value) => value.records)).size).toBe(1);
  expect(new Set(tail.map((value) => value.disk)).size).toBe(1);
  expect(result.samples.every((value) => value.bytes <= 256 * 1024 * 1024 && value.disk <= 512 * 1024 * 1024)).toBe(true);
  expect(Math.max(...tail.map((value) => value.heapUsed)) - Math.min(...tail.map((value) => value.heapUsed))).toBeLessThan(24 * 1024 * 1024);
  // Generous isolation ceiling, not a cross-platform production memory promise.
  expect(Math.max(...result.samples.map((value) => value.rss)) - result.baseline.rss).toBeLessThan(192 * 1024 * 1024);
  console.info("delivery pressure fixture", JSON.stringify(result));
}, 50_000);

it("stops reliable intake at the snapshot limit across EventBus, SurfaceManager, Worker and Outbox", () => {
  const root = fixture();
  const script = join(root, "burst.mjs");
  writeFileSync(script, `
    import { DeliveryJournal } from ${moduleUrl("dist/delivery/index.js")};
    import { SurfaceManager } from ${moduleUrl("dist/bootstrap/surface-manager.js")};
    import { EventBus } from ${moduleUrl("dist/event-bus/index.js")};
    import { FeishuOutbox } from ${moduleUrl("dist/surfaces/feishu/outbox.js")};
    import pino from ${moduleUrl("node_modules/pino/pino.js")};
    const logger = pino({ level: 'silent' });
    let started = 0, stopped, overflows = 0;
    const faults = [];
    const output = new EventBus(logger, 1000, undefined, {
      entries: 2048, bytes: 32 * 1024 * 1024, size: (event) => Buffer.byteLength(JSON.stringify(event)),
      overflow: () => { overflows++; stopped ??= manager.stop(); },
    });
    const send = async (_id, _text, signal) => {
      started++;
      signal.throwIfAborted();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled platform fixture')), { once: true }));
    };
    const outbox = new FeishuOutbox('default', {
      sendText: send, sendPost: send, sendMarkdownCard: send, sendCard: send, updateCard: send,
      createStreamingCard: async () => ({ cardId: 'card', messageId: 'message' }),
      updateStreamingCard: send, finishStreamingCard: send,
    }, logger);
    const surface = { surface: 'feishu', accountId: 'default', output: outbox,
      interactions: { request: async () => ({ type: 'approval', approved: false }) },
      start: async () => {}, stop: () => outbox.close(), configurationChanged: () => {}, deliverConfigurationChange: async () => {} };
    const manager = new SurfaceManager([surface], output, logger, undefined, { persistence: {
      directory: process.argv[2], owner: () => 'owner', authorized: () => true,
      fault: (code) => { faults.push(code); stopped ??= manager.stop(); },
    } });
    const publish = (id) => output.publish({ type: 'text.completed', target: { surface: 'feishu', accountId: 'default', conversationId: String(id) },
      threadId: 'thread-' + id, turnId: 'turn', itemId: 'item', phase: 'final_answer', text: 'x'.repeat(1024) }, true);
    await manager.start();
    for (let id = 0; id < 8; id++) publish(id);
    const deadline = Date.now() + 5000;
    while (started < 8) { if (Date.now() > deadline) throw new Error('platform did not start'); await new Promise(r => setTimeout(r, 10)); }
    global.gc();
    const baseline = process.memoryUsage().rss;
    const start = performance.now();
    for (let id = 8; id < 8200; id++) publish(id);
    await stopped;
    await output.close();
    const closeMs = performance.now() - start;
    global.gc();
    const journal = new DeliveryJournal(process.argv[2]);
    await journal.ready;
    const summary = await journal.summary();
    const head = await journal.next();
    await journal.close();
    console.log(JSON.stringify({ started, faults, overflows, summary, head: JSON.parse(head.payload).event.target.conversationId,
      closeMs, rssGrowth: process.memoryUsage().rss - baseline }));
  `);
  const child = spawnSync(process.execPath, ["--expose-gc", script, join(root, "journal")], { timeout: 15_000, encoding: "utf8" });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as {
    started: number; faults: string[]; overflows: number; summary: { records: number; uncertain: number; pending: number };
    head: string; closeMs: number; rssGrowth: number;
  };
  expect(result.started).toBe(8);
  expect(result.faults).toEqual(["mailbox-full", ...Array<string>(8).fill("delivery-uncertain")]);
  expect(result.overflows).toBe(1);
  expect(result.summary).toMatchObject({ records: 136, uncertain: 8, pending: 128 });
  expect(result.head).toBe("8");
  expect(result.closeMs).toBeLessThan(6_000);
  expect(result.rssGrowth).toBeLessThan(96 * 1024 * 1024);
  console.info("delivery burst fixture", JSON.stringify(result));
}, 20_000);
