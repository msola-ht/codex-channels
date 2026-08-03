import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createResponsesVisionAdapter } from "../src/bootstrap/responses-vision-adapter.js";

describe("Responses vision adapter", () => {
  it("sends validated images to one Responses request and crops the stable result", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-vision-"));
    const imagePath = join(root, "image.png");
    writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]));
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void input;
      void init;
      return new Response(JSON.stringify({
        model: "gpt-5.6-luna",
        status: "completed",
        created_at: 1_785_640_800,
        completed_at: 1_785_640_814,
        service_tier: "default",
        usage: {
          input_tokens: 1_234,
          input_tokens_details: {
            cached_tokens: 120,
            cache_write_tokens: 10,
          },
          output_tokens: 56,
          output_tokens_details: {
            reasoning_tokens: 12,
          },
          total_tokens: 1_290,
        },
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              images: [{
                index: 1,
                description: "图片描述",
                extractedText: null,
                uncertainty: null,
              }],
            }),
          }],
        }],
      }), { status: 200 });
    });
    const enqueueMetric = vi.fn();
    const adapter = createResponsesVisionAdapter({
      provider: "vision-relay",
      providerName: "测试中转",
      endpoint: "https://vision.example/v1/responses",
      model: "vision-model",
      loadApiKey: () => "private-key",
      fetchImpl,
      onMetric: enqueueMetric,
    });
    const onRequestStarted = vi.fn();

    await expect(adapter.recognize({
      images: [{ path: imagePath }],
      userPrompt: "解释截图里的错误",
      onRequestStarted,
      threadId: "thread-vision",
    })).resolves.toEqual({
      provider: "测试中转",
      model: "gpt-5.6-luna",
      elapsedMs: expect.any(Number),
      upstreamDurationMs: 14_000,
      serviceTier: "default",
      usage: {
        inputTokens: 1_234,
        cachedInputTokens: 120,
        cacheWriteInputTokens: 10,
        outputTokens: 56,
        reasoningOutputTokens: 12,
        totalTokens: 1_290,
      },
      images: [{
        index: 1,
        description: "图片描述",
        extractedText: null,
        uncertainty: null,
      }],
    });

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toEqual(expect.objectContaining({
      authorization: "Bearer private-key",
    }));
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "vision-model",
      input: [{
        content: [
          expect.objectContaining({ type: "input_text" }),
          expect.objectContaining({
            type: "input_image",
            image_url: expect.stringMatching(/^data:image\/png;base64,/),
          }),
        ],
      }],
      text: { format: { type: "json_schema", strict: true } },
    });
    const body = String(init?.body);
    expect(body).toContain("解释截图里的错误");
    expect(body).toContain("只做视觉观察和文字提取");
    expect(body).toContain("仅用于确定观察和文字提取重点");
    expect(body).toContain("不要分析、核实或回答用户的问题");
    expect(body).not.toContain("按顺序分析这");
    expect(onRequestStarted).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(
      onRequestStarted.mock.invocationCallOrder[0]!,
    );
    expect(enqueueMetric).toHaveBeenCalledWith(expect.objectContaining({
      provider: "vision-relay",
      pricing: null,
      transport: "http",
      responseFormat: "json",
      operation: "response",
      threadId: "thread-vision",
      turnId: null,
      model: "gpt-5.6-luna",
      serviceTier: "default",
      status: "completed",
      httpStatus: 200,
      inputTokens: 1_234,
      cachedInputTokens: 120,
      outputTokens: 56,
      reasoningOutputTokens: 12,
      totalTokens: 1_290,
    }));
  });

  it("rejects a successful HTTP response whose upstream status is incomplete", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-vision-"));
    const imagePath = join(root, "image.png");
    writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]));
    const onMetric = vi.fn();
    const adapter = createResponsesVisionAdapter({
      provider: "vision-relay",
      providerName: "测试中转",
      endpoint: "https://vision.example/v1/responses",
      model: "vision-model",
      loadApiKey: () => "private-key",
      fetchImpl: async () => new Response(JSON.stringify({
        model: "gpt-5.6-luna",
        status: "incomplete",
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              images: [{
                index: 1,
                description: "不完整图片描述",
                extractedText: null,
                uncertainty: null,
              }],
            }),
          }],
        }],
      }), { status: 200 }),
      onMetric,
    });

    await expect(adapter.recognize({
      images: [{ path: imagePath }],
      userPrompt: "识别图片",
      onRequestStarted: vi.fn(),
    })).rejects.toThrow("响应尚未完成");
    expect(onMetric).toHaveBeenCalledWith(expect.objectContaining({
      provider: "vision-relay",
      model: "gpt-5.6-luna",
      status: "incomplete",
      httpStatus: 200,
      errorType: "vision_incomplete",
    }));
  });

  it("records a sanitized failed metric when the upstream rejects the request", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-vision-"));
    const imagePath = join(root, "image.png");
    writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]));
    const onMetric = vi.fn();
    const adapter = createResponsesVisionAdapter({
      provider: "vision-relay",
      providerName: "测试中转",
      endpoint: "https://vision.example/v1/responses",
      model: "vision-model",
      loadApiKey: () => "private-key",
      fetchImpl: async () => new Response("private upstream error", { status: 503 }),
      onMetric,
    });

    await expect(adapter.recognize({
      images: [{ path: imagePath }],
      userPrompt: "识别图片",
      onRequestStarted: vi.fn(),
      threadId: "thread-vision",
    })).rejects.toThrow("HTTP 503");
    expect(onMetric).toHaveBeenCalledWith(expect.objectContaining({
      provider: "vision-relay",
      threadId: "thread-vision",
      turnId: null,
      model: "vision-model",
      status: "failed",
      httpStatus: 503,
      errorType: "vision_http_error",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    }));
    expect(JSON.stringify(onMetric.mock.calls)).not.toContain("private upstream error");
  });

  it("does not send a request when the stored key is absent", async () => {
    const fetchImpl = vi.fn();
    const onRequestStarted = vi.fn();
    const adapter = createResponsesVisionAdapter({
      provider: "测试中转",
      endpoint: "https://vision.example/v1/responses",
      model: "vision-model",
      loadApiKey: () => "",
      fetchImpl,
    });

    await expect(adapter.recognize({
      images: [{ path: "/private/image.png" }],
      userPrompt: "识别图片",
      onRequestStarted,
    }))
      .rejects.toThrow("凭据未设置");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onRequestStarted).not.toHaveBeenCalled();
  });

  it("keeps the request timeout active while reading the response body", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-vision-"));
    const imagePath = join(root, "image.png");
    writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]));
    let requestSignal: AbortSignal | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const adapter = createResponsesVisionAdapter({
      provider: "测试中转",
      endpoint: "https://vision.example/v1/responses",
      model: "vision-model",
      loadApiKey: () => "private-key",
      requestTimeoutMs: 10,
      fetchImpl: async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            requestSignal?.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
            }, { once: true });
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    const recognition = adapter.recognize({
      images: [{ path: imagePath }],
      userPrompt: "识别图片",
      onRequestStarted: vi.fn(),
    }).catch((error: unknown) => error);

    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const aborted = requestSignal?.aborted ?? false;
    if (!aborted) bodyController?.error(new Error("test cleanup"));
    await recognition;
    expect(aborted).toBe(true);
  });
});
