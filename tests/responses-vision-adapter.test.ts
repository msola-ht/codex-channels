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
    const adapter = createResponsesVisionAdapter({
      endpoint: "https://vision.example/v1/responses",
      model: "vision-model",
      loadApiKey: () => "private-key",
      fetchImpl,
    });
    const onRequestStarted = vi.fn();

    await expect(adapter.recognize({
      images: [{ path: imagePath }],
      userPrompt: "解释截图里的错误",
      onRequestStarted,
    })).resolves.toEqual({
      provider: "外部视觉 API",
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
  });

  it("rejects a successful HTTP response whose upstream status is incomplete", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-vision-"));
    const imagePath = join(root, "image.png");
    writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]));
    const adapter = createResponsesVisionAdapter({
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
    });

    await expect(adapter.recognize({
      images: [{ path: imagePath }],
      userPrompt: "识别图片",
      onRequestStarted: vi.fn(),
    })).rejects.toThrow("响应尚未完成");
  });

  it("does not send a request when the stored key is absent", async () => {
    const fetchImpl = vi.fn();
    const onRequestStarted = vi.fn();
    const adapter = createResponsesVisionAdapter({
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
});
