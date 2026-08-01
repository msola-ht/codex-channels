import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationTarget } from "../src/conversation-core/index.js";
import { SurfaceInputCoalescer } from "../src/surfaces/surface-input-coalescer.js";

const target: ConversationTarget = {
  surface: "weixin",
  accountId: "account@im.bot",
  conversationId: "conversation@im.wechat",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("SurfaceInputCoalescer", () => {
  it("submits a complete explicitly sized platform batch without waiting", async () => {
    const submit = vi.fn<(
      target: ConversationTarget,
      input: unknown,
    ) => Promise<{ threadId: string; turnId: string; steered: boolean }>>(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const coalescer = new SurfaceInputCoalescer(submit, {
      quietWindowMs: 1_000,
    });

    const first = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 1,
      aggregationKey: "platform-batch",
      aggregationSize: 2,
      text: "比较这些图片",
      localImages: [{ path: "/private/first.png" }],
    });
    const second = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 2,
      aggregationKey: "platform-batch",
      aggregationSize: 2,
      localImages: [{ path: "/private/second.png" }],
    });

    await expect(first).resolves.toMatchObject({ tail: false });
    await expect(second).resolves.toMatchObject({ tail: true });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(target, {
      text: "比较这些图片",
      localImages: [
        { path: "/private/first.png" },
        { path: "/private/second.png" },
      ],
    });
  });

  it("isolates batches by actor even inside one conversation", async () => {
    vi.useFakeTimers();
    const submit = vi.fn<(
      target: ConversationTarget,
      input: unknown,
    ) => Promise<{ threadId: string; turnId: string; steered: boolean }>>(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const coalescer = new SurfaceInputCoalescer(submit, {
      quietWindowMs: 1_000,
    });

    const first = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 1,
      text: "first",
    });
    const second = coalescer.enqueue({
      target,
      actorId: "actor-2",
      sequence: 2,
      text: "second",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith(target, "first");
    expect(submit).toHaveBeenCalledWith(target, "second");
  });

  it("flushes pending input during close and rejects later input", async () => {
    vi.useFakeTimers();
    const submit = vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const coalescer = new SurfaceInputCoalescer(submit, {
      quietWindowMs: 1_000,
    });
    const pending = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 1,
      aggregationKey: "platform-batch",
      localImages: [{ path: "/private/only.png" }],
    });

    await coalescer.close();

    await expect(pending).resolves.toMatchObject({ tail: true });
    expect(submit).toHaveBeenCalledWith(target, {
      text: "请查看这张图片并根据图片内容协助我。",
      localImages: [{ path: "/private/only.png" }],
    });
    await expect(coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 2,
      text: "late",
    })).rejects.toThrow("输入聚合器已关闭");
  });

  it("consumes a pending vision prompt only for the next image batch", async () => {
    vi.useFakeTimers();
    const submit = vi.fn<(
      target: ConversationTarget,
      input: unknown,
    ) => Promise<{ threadId: string; turnId: string; steered: boolean }>>(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const coalescer = new SurfaceInputCoalescer(submit, {
      quietWindowMs: 10,
    });

    expect(coalescer.setVisionPrompt(target, "actor-1", "检查报错")).toEqual({
      replaced: false,
    });
    const text = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 1,
      text: "普通消息",
    });
    await vi.advanceTimersByTimeAsync(10);
    await text;
    const image = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 2,
      text: "重点看右下角",
      localImages: [{ path: "/private/error.png" }],
    });
    await vi.advanceTimersByTimeAsync(10);
    await image;
    const nextImage = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 3,
      localImages: [{ path: "/private/next.png" }],
    });
    await vi.advanceTimersByTimeAsync(10);
    await nextImage;

    expect(submit.mock.calls[0]?.[1]).toBe("普通消息");
    expect(submit.mock.calls[1]?.[1]).toEqual({
      text: "检查报错\n\n重点看右下角",
      localImages: [{ path: "/private/error.png" }],
    });
    expect(submit.mock.calls[2]?.[1]).toMatchObject({
      localImages: [{ path: "/private/next.png" }],
    });
    expect(submit.mock.calls[2]?.[1]).not.toMatchObject({ text: "检查报错" });
  });

  it("isolates, replaces, cancels, and expires pending vision prompts", async () => {
    vi.useFakeTimers();
    const submit = vi.fn<(
      target: ConversationTarget,
      input: unknown,
    ) => Promise<{ threadId: string; turnId: string; steered: boolean }>>(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    }));
    const coalescer = new SurfaceInputCoalescer(submit, {
      quietWindowMs: 0,
      visionPromptTtlMs: 100,
    });

    expect(coalescer.setVisionPrompt(target, "actor-1", "first")).toEqual({ replaced: false });
    expect(coalescer.setVisionPrompt(target, "actor-1", "second")).toEqual({ replaced: true });
    expect(coalescer.setVisionPrompt(target, "actor-2", "other")).toEqual({ replaced: false });
    expect(coalescer.cancelVisionPrompt(target, "actor-2")).toBe(true);
    expect(coalescer.cancelVisionPrompt(target, "actor-2")).toBe(false);
    await vi.advanceTimersByTimeAsync(100);

    const image = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 1,
      localImages: [{ path: "/private/expired.png" }],
    });
    await vi.runAllTimersAsync();
    await image;
    expect(submit.mock.calls[0]?.[1]).not.toMatchObject({ text: "second" });
  });

  it("bounds pending vision prompts without blocking replacement", () => {
    const coalescer = new SurfaceInputCoalescer(vi.fn(), {
      maximumPendingVisionPrompts: 1,
    });
    coalescer.setVisionPrompt(target, "actor-1", "first");
    expect(coalescer.setVisionPrompt(target, "actor-1", "replacement"))
      .toEqual({ replaced: true });
    expect(() => coalescer.setVisionPrompt(target, "actor-2", "other"))
      .toThrow("待处理的图片识别要求已满");
  });

  it("rejects the whole pending batch when a later image exceeds its limits", async () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const coalescer = new SurfaceInputCoalescer(submit, {
      quietWindowMs: 1_000,
      maximumImages: 1,
    });
    const first = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 1,
      aggregationKey: "platform-batch",
      localImages: [{ path: "/private/first.png" }],
    });
    const second = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 2,
      aggregationKey: "platform-batch",
      localImages: [{ path: "/private/second.png" }],
    });

    await expect(first).rejects.toMatchObject({ code: "image.too-many" });
    await expect(second).rejects.toMatchObject({ code: "image.too-many" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submit).not.toHaveBeenCalled();
  });
});
