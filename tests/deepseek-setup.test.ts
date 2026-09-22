import { describe, expect, it, vi } from "vitest";
import { downloadDeepseekCatalog, extractDeepseekCatalog } from "../scripts/deepseek-setup.mjs";
const script = `#!/bin/sh
cat > "$TMP_MODELS" <<'CODEX_MODELS_JSON'
{"models":[{"slug":"deepseek-flash","display_name":"DeepSeek-Flash","input_modalities":["text","image"],"context_window":1048576,"max_context_window":1048576,"default_reasoning_level":"high","supported_reasoning_levels":[{"effort":"low","description":"Low"},{"effort":"high","description":"High"},{"effort":"max","description":"Max"}]},{"slug":"deepseek-v4-pro","display_name":"DeepSeek-V4-Pro","input_modalities":["text"],"context_window":1048576,"max_context_window":1048576,"default_reasoning_level":"high","supported_reasoning_levels":[{"effort":"low","description":"Low"},{"effort":"high","description":"High"},{"effort":"max","description":"Max"}]}]}
CODEX_MODELS_JSON
`;

function successfulFetch() { return Promise.resolve(new Response(script, { status: 200 })); }

describe("DeepSeek official catalog download", () => {
  it("extracts exactly one catalog", () => {
    expect(extractDeepseekCatalog(script).models).toHaveLength(2);
    expect(() => extractDeepseekCatalog("no catalog")).toThrow("模型目录标记无效");
  });
  it("retries retryable download failures and passes an abort signal", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockImplementationOnce(successfulFetch);

    await expect(downloadDeepseekCatalog(fetchImpl, {
      sleep: async () => undefined,
    })).resolves.toMatchObject({ catalog: { models: expect.any(Array) } });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("times out a stalled official script download", async () => {
    const fetchImpl = vi.fn((
      _url: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    await expect(downloadDeepseekCatalog(fetchImpl, {
      attempts: 1,
      timeoutMs: 5,
    })).rejects.toThrow("下载超时");
  });

  it("stops reading an oversized streamed official script", async () => {
    const oversizedChunk = new Uint8Array((2 * 1024 * 1024) + 1);
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(oversizedChunk);
        controller.close();
      },
    })));

    await expect(downloadDeepseekCatalog(fetchImpl, { attempts: 1 }))
      .rejects.toThrow("超过允许大小");
  });

});
