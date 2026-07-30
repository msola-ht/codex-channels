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
  it("submits adjacent text and images as one ordered input after the quiet window", async () => {
    vi.useFakeTimers();
    const submit = vi.fn(async () => ({
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
      text: "比较这些图片",
      localImages: [{ path: "/private/first.png" }],
    });
    const second = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 2,
      localImages: [{ path: "/private/second.png" }],
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

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
    const submit = vi.fn(async () => ({
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
      localImages: [{ path: "/private/first.png" }],
    });
    const second = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 2,
      localImages: [{ path: "/private/second.png" }],
    });

    await expect(first).rejects.toMatchObject({ code: "image.too-many" });
    await expect(second).rejects.toMatchObject({ code: "image.too-many" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submit).not.toHaveBeenCalled();
  });
});
