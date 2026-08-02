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
        usage: {
          input_tokens: 1_234,
          output_tokens: 56,
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
      model: "vision-model",
      elapsedMs: expect.any(Number),
      usage: {
        inputTokens: 1_234,
        outputTokens: 56,
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
