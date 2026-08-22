import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationTarget } from "../src/conversation-core/index.js";
import { maximumGeneratedImageBytes } from "../src/surfaces/generated-image.js";
import { SurfaceInputCoalescer } from "../src/surfaces/surface-input-coalescer.js";

const target: ConversationTarget = {
  surface: "weixin",
  accountId: "account@im.bot",
  conversationId: "conversation@im.wechat",
};

const tinyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function writeTinyPng(name: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "codex-input-"));
  const path = join(directory, name);
  writeFileSync(path, tinyPng, { mode: 0o600 });
  return { directory, path };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SurfaceInputCoalescer", () => {
  it("submits stored PNGs as inline data URLs without their local paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-input-"));
    const imagePath = join(directory, "image.png");
    const imageBytes = tinyPng;
    writeFileSync(imagePath, imageBytes, { mode: 0o600 });
    try {
      const submit = vi.fn(async () => ({
        threadId: "thread",
        turnId: "turn",
        steered: false,
      }));
      const coalescer = new SurfaceInputCoalescer(submit, {
        quietWindowMs: 0,
      });

      await coalescer.enqueue({
        target,
        actorId: "actor-1",
        sequence: 1,
        text: "查看图片",
        localImages: [{
          path: imagePath,
          mimeType: "image/png",
          bytes: imageBytes.length,
        }],
      });

      expect(submit).toHaveBeenCalledWith(target, {
        text: "查看图片",
        images: [{ url: "data:image/png;base64,iVBORw0KGgo=" }],
      });
      expect(JSON.stringify(submit.mock.calls[0])).not.toContain(imagePath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rechecks actual image bytes and trusted MIME before submission", async () => {
    const image = writeTinyPng("mismatch.png");
    try {
      const submit = vi.fn();
      const coalescer = new SurfaceInputCoalescer(submit, {
        quietWindowMs: 0,
        maximumImageBytes: tinyPng.length - 1,
      });

      await expect(coalescer.enqueue({
        target,
        actorId: "actor-1",
        sequence: 1,
        localImages: [{
          path: image.path,
          mimeType: "image/jpeg",
          bytes: 0,
        }],
      })).rejects.toMatchObject({ code: "image.unsupported" });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      rmSync(image.directory, { recursive: true, force: true });
    }
  });

  it("enforces the batch byte limit using bytes read from disk", async () => {
    const image = writeTinyPng("oversized.png");
    try {
      const submit = vi.fn();
      const coalescer = new SurfaceInputCoalescer(submit, {
        quietWindowMs: 0,
        maximumImageBytes: tinyPng.length - 1,
      });

      await expect(coalescer.enqueue({
        target,
        actorId: "actor-1",
        sequence: 1,
        localImages: [{
          path: image.path,
          mimeType: "image/png",
          bytes: 0,
        }],
      })).rejects.toMatchObject({ code: "image.too-large" });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      rmSync(image.directory, { recursive: true, force: true });
    }
  });

  it("reports an image that grows past the per-file limit as too large", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-input-"));
    const imagePath = join(directory, "grown.png");
    writeFileSync(
      imagePath,
      Buffer.concat([
        tinyPng,
        Buffer.alloc(maximumGeneratedImageBytes - tinyPng.length + 1),
      ]),
      { mode: 0o600 },
    );
    try {
      const submit = vi.fn();
      const coalescer = new SurfaceInputCoalescer(submit, {
        quietWindowMs: 0,
      });

      await expect(coalescer.enqueue({
        target,
        actorId: "actor-1",
        sequence: 1,
        localImages: [{
          path: imagePath,
          mimeType: "image/png",
          bytes: tinyPng.length,
        }],
      })).rejects.toMatchObject({ code: "image.too-large" });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("submits a complete explicitly sized platform batch without waiting", async () => {
    const firstImage = writeTinyPng("first.png");
    const secondImage = writeTinyPng("second.png");
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
      aggregationKey: "platform-batch",
      aggregationSize: 2,
      text: "比较这些图片",
      localImages: [{
        path: firstImage.path,
        mimeType: "image/png",
        bytes: tinyPng.length,
      }],
    });
    const second = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 2,
      aggregationKey: "platform-batch",
      aggregationSize: 2,
      localImages: [{
        path: secondImage.path,
        mimeType: "image/png",
        bytes: tinyPng.length,
      }],
    });

    await expect(first).resolves.toMatchObject({ tail: false });
    await expect(second).resolves.toMatchObject({ tail: true });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(target, {
      text: "比较这些图片",
      images: [
        { url: "data:image/png;base64,iVBORw0KGgo=" },
        { url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    });
    rmSync(firstImage.directory, { recursive: true, force: true });
    rmSync(secondImage.directory, { recursive: true, force: true });
  });

  it("isolates batches by actor inside one conversation", async () => {
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
    const image = writeTinyPng("only.png");
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
      localImages: [{
        path: image.path,
        mimeType: "image/png",
        bytes: tinyPng.length,
      }],
    });

    await coalescer.close();

    await expect(pending).resolves.toMatchObject({ tail: true });
    expect(submit).toHaveBeenCalledWith(target, {
      text: "请查看这张图片并根据图片内容协助我。",
      images: [{ url: "data:image/png;base64,iVBORw0KGgo=" }],
    });
    rmSync(image.directory, { recursive: true, force: true });
    await expect(coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 2,
      text: "late",
    })).rejects.toThrow("输入聚合器已关闭");
  });

  it("rejects the whole pending batch when a later image exceeds its limits", async () => {
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
      localImages: [{
        path: "/private/first.png",
        mimeType: "image/png",
      }],
    });
    const second = coalescer.enqueue({
      target,
      actorId: "actor-1",
      sequence: 2,
      aggregationKey: "platform-batch",
      localImages: [{
        path: "/private/second.png",
        mimeType: "image/png",
      }],
    });

    await expect(first).rejects.toMatchObject({ code: "image.too-many" });
    await expect(second).rejects.toMatchObject({ code: "image.too-many" });
    expect(submit).not.toHaveBeenCalled();
  });
});
