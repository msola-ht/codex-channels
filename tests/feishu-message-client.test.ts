import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuMessageError,
  FeishuMessageClient,
} from "../src/surfaces/feishu/client.js";
import type {
  FeishuCardDocument,
} from "../src/surfaces/feishu/approval-card.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("FeishuMessageClient", () => {
  it("rejects invalid credentials before creating the SDK client", () => {
    const createSdkClient = vi.fn();

    expect(() => new FeishuMessageClient(
      {
        appId: "invalid",
        appSecret: "",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient,
      },
    )).toThrow(new FeishuMessageError(
      "invalid-credentials",
      "飞书应用凭据格式无效",
    ));
    expect(createSdkClient).not.toHaveBeenCalled();
  });

  it("hides SDK client creation error details", () => {
    expect(() => new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => {
          throw new Error("appSecret=secret");
        },
      },
    )).toThrow(new FeishuMessageError(
      "client-create-failed",
      "飞书消息客户端创建失败",
    ));
  });

  it("sends a text message to an exact chat ID", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_message" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(client.sendText("oc_chat", "飞书回复")).resolves.toBeUndefined();

    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "text",
        content: "{\"text\":\"飞书回复\"}",
      },
    });
  });

  it("sends Markdown as a Feishu rich-text post to an exact chat ID", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_message" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendPost("oc_chat", "**状态**\n\n- 正常"),
    ).resolves.toBeUndefined();

    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "",
            content: [[{
              tag: "md",
              text: "**状态**\n\n- 正常",
            }]],
          },
        }),
      },
    });
  });

  it("uploads and sends a generated text file to an exact chat ID", async () => {
    const createFile = vi.fn(async () => ({
      file_key: "file_final_answer",
    }));
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_file" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createFile,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );
    const file = Buffer.from("完整回复", "utf8");

    await expect(
      client.sendFile("oc_chat", "codex-final-answer.txt", file),
    ).resolves.toBeUndefined();

    expect(createFile).toHaveBeenCalledWith({
      data: {
        file_type: "stream",
        file_name: "codex-final-answer.txt",
        file,
      },
    });
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "file",
        content: "{\"file_key\":\"file_final_answer\"}",
      },
    });
  });

  it("fails closed when a file upload omits its file key", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_file" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createFile: async () => ({}),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendFile(
        "oc_chat",
        "codex-final-answer.txt",
        Buffer.from("完整回复", "utf8"),
      ),
    ).rejects.toMatchObject({
      name: "FeishuMessageError",
      code: "invalid-response",
      message: "飞书文件上传响应无效",
    });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("uploads and sends a generated image to an exact chat ID", async () => {
    const createImage = vi.fn(async () => ({
      image_key: "img_generated",
    }));
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_image" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createImage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );
    const image = Buffer.from("validated-image");

    await expect(
      client.sendImage("oc_chat", image),
    ).resolves.toBeUndefined();

    expect(createImage).toHaveBeenCalledWith({
      data: {
        image_type: "message",
        image,
      },
    });
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "image",
        content: "{\"image_key\":\"img_generated\"}",
      },
    });
  });

  it("fails closed when an image upload omits its image key", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_image" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createImage: async () => ({}),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendImage("oc_chat", Buffer.from("validated-image")),
    ).rejects.toMatchObject({
      name: "FeishuMessageError",
      code: "invalid-response",
      message: "飞书图片上传响应无效",
    });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("replies to an exact Feishu message with a Markdown CardKit card", async () => {
    const replyMessage = vi.fn(async () => ({
      data: { message_id: "om_reply" },
    }));
    const createStreamingCard = vi.fn(async () => ({
      code: 0,
      data: { card_id: "7355372766134157313" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          replyMessage,
          patchMessage: successfulPatch,
          createStreamingCard,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.replyMarkdownCard("om_origin", "**已开始处理。**"),
    ).resolves.toBe("om_reply");

    expect(replyMessage).toHaveBeenCalledWith({
      path: { message_id: "om_origin" },
      data: {
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: "7355372766134157313",
          },
        }),
        reply_in_thread: false,
      },
    });
  });

  it("creates and sends a native streaming CardKit card", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_stream" },
    }));
    const createStreamingCard = vi.fn(async () => ({
      code: 0,
      data: { card_id: "7355372766134157313" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.createStreamingCard("oc_chat", "开始回答"),
    ).resolves.toEqual({
      cardId: "7355372766134157313",
      messageId: "om_stream",
    });

    expect(createStreamingCard).toHaveBeenCalledWith({
      data: {
        type: "card_json",
        data: JSON.stringify({
          schema: "2.0",
          config: {
            streaming_mode: true,
            summary: {
              content: "生成中",
            },
            streaming_config: {
              print_frequency_ms: {
                default: 70,
              },
              print_step: {
                default: 1,
              },
              print_strategy: "fast",
            },
          },
          body: {
            elements: [{
              tag: "markdown",
              element_id: "codexc_stream",
              content: "开始回答",
            }],
          },
        }),
      },
    });
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: "7355372766134157313",
          },
        }),
      },
    });
  });

  it("creates and sends a static CardKit Markdown card", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_static" },
    }));
    const createStreamingCard = vi.fn(async () => ({
      code: 0,
      data: { card_id: "7355372766134157313" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendMarkdownCard("oc_chat", "**状态**\n\n- 正常"),
    ).resolves.toBe("om_static");

    expect(createStreamingCard).toHaveBeenCalledWith({
      data: {
        type: "card_json",
        data: JSON.stringify({
          schema: "2.0",
          config: {
            summary: {
              content: "**状态** - 正常",
            },
          },
          body: {
            elements: [{
              tag: "markdown",
              content: "**状态**\n\n- 正常",
            }],
          },
        }),
      },
    });
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: "7355372766134157313",
          },
        }),
      },
    });
  });

  it("reports a stable error before message send when static CardKit creation fails", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_fallback" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createStreamingCard: async () => {
            throw new Error("card create failed");
          },
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendMarkdownCard("oc_chat", "**状态**\n\n- 正常"),
    ).rejects.toMatchObject({
      code: "card-create-failed",
      message: "飞书静态卡片创建失败",
    });

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("neutralizes platform-native mentions in every static CardKit field", async () => {
    const createStreamingCard = vi.fn(async () => ({
      code: 0,
      data: { card_id: "7355372766134157313" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_static" },
          }),
          createStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await client.sendMarkdownCard(
      "oc_chat",
      "<at user_id=\"all\">所有人</at>",
    );

    expect(JSON.stringify(createStreamingCard.mock.calls))
      .not.toContain("<at");
    expect(JSON.stringify(createStreamingCard.mock.calls))
      .toContain("&lt;at");
  });

  it("updates and finishes a native streaming CardKit card in sequence", async () => {
    const updateStreamingCard = vi.fn(async () => ({ code: 0 }));
    const finishStreamingCard = vi.fn(async (payload: {
      path: { card_id: string };
      data: {
        card: { type: "card_json"; data: string };
        sequence: number;
        uuid: string;
      };
    }) => {
      void payload;
      return { code: 0 };
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          updateStreamingCard,
          finishStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateStreamingCard("7355372766134157313", "完整正文", 1),
    ).resolves.toBeUndefined();
    await expect(
      client.finishStreamingCard("7355372766134157313", 2, "完整正文"),
    ).resolves.toBeUndefined();

    expect(updateStreamingCard).toHaveBeenCalledWith({
      path: {
        card_id: "7355372766134157313",
        element_id: "codexc_stream",
      },
      data: {
        content: "完整正文",
        sequence: 1,
        uuid: "c_7355372766134157313_1",
      },
    });
    expect(finishStreamingCard).toHaveBeenCalledWith({
      path: {
        card_id: "7355372766134157313",
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify({
            schema: "2.0",
            config: {
              streaming_mode: false,
              summary: {
                content: "完整正文",
              },
            },
            body: {
              elements: [{
                tag: "markdown",
                element_id: "codexc_stream",
                content: "完整正文",
              }],
            },
          }),
        },
        sequence: 2,
        uuid: "f_7355372766134157313_2",
      },
    });
  });

  it("finalizes a streaming card with the complete static markdown body", async () => {
    const finishStreamingCard = vi.fn(async () => ({ code: 0 }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          finishStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await client.finishStreamingCard(
      "7355372766134157313",
      2,
      "结尾不能少字：尚未推送。",
      "**本次运行 · 已完成**",
    );

    expect(finishStreamingCard).toHaveBeenCalledWith({
      path: {
        card_id: "7355372766134157313",
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify({
            schema: "2.0",
            config: {
              streaming_mode: false,
              summary: {
                content: "结尾不能少字：尚未推送。",
              },
            },
            body: {
              elements: [
                {
                  tag: "markdown",
                  element_id: "codexc_stream",
                  content: "结尾不能少字：尚未推送。",
                },
                {
                  tag: "hr",
                },
                {
                  tag: "markdown",
                  content: "**本次运行 · 已完成**",
                },
              ],
            },
          }),
        },
        sequence: 2,
        uuid: "f_7355372766134157313_2",
      },
    });
  });

  it("maps CardKit update failures to a stable response error", async () => {
    const updateStreamingCard = vi.fn(async () => ({
      code: 99_999,
      message: "app_secret=secret",
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          updateStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateStreamingCard("7355372766134157313", "正文", 1),
    ).rejects.toEqual(new FeishuMessageError(
      "invalid-response",
      "飞书流式卡片更新响应无效",
    ));
  });

  it("classifies CardKit rate limits without exposing the SDK response", async () => {
    const updateStreamingCard = vi.fn(async () => ({
      code: 99991400,
      message: "app_secret=secret",
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          updateStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateStreamingCard("7355372766134157313", "正文", 1),
    ).rejects.toEqual(new FeishuMessageError(
      "rate-limited",
      "飞书流式卡片更新请求受限",
    ));
  });

  it("classifies HTTP 429 CardKit failures without exposing the response", async () => {
    const updateStreamingCard = vi.fn(async () => {
      throw {
        response: {
          status: 429,
          data: {
            message: "app_secret=secret",
          },
        },
      };
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          updateStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateStreamingCard("7355372766134157313", "正文", 1),
    ).rejects.toEqual(new FeishuMessageError(
      "rate-limited",
      "飞书流式卡片更新请求受限",
    ));
  });

  it("keeps a streaming summary within fifty UTF-16 code units", async () => {
    const finishStreamingCard = vi.fn(async (payload: {
      path: { card_id: string };
      data: {
        card: { type: "card_json"; data: string };
        sequence: number;
        uuid: string;
      };
    }) => {
      void payload;
      return { code: 0 };
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          finishStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await client.finishStreamingCard(
      "7355372766134157313",
      1,
      "😀".repeat(60),
    );

    const payload = finishStreamingCard.mock.calls[0]?.[0];
    const card = JSON.parse(payload?.data.card.data ?? "{}") as {
      config?: { summary?: { content?: string } };
    };
    expect(card.config?.summary?.content).toBe(
      `${"😀".repeat(24)}…`,
    );
    expect(card.config?.summary?.content?.length).toBeLessThanOrEqual(50);
  });

  it("creates and updates an interactive card without retrying", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_card" },
    }));
    const patchMessage = vi.fn(async () => ({ code: 0 }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage,
          downloadResource: successfulDownload,
        }),
      },
    );
    const card = approvalCard();

    await expect(client.sendCard("oc_chat", card)).resolves.toBe("om_card");
    await expect(client.updateCard("om_card", card)).resolves.toBeUndefined();

    expect(createMessage).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    expect(patchMessage).toHaveBeenCalledOnce();
    expect(patchMessage).toHaveBeenCalledWith({
      path: {
        message_id: "om_card",
      },
      data: {
        content: JSON.stringify(card),
      },
    });
  });

  it("fails closed when a message update response reports an error", async () => {
    const patchMessage = vi.fn(async () => ({ code: 999 }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          patchMessage,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateCard("om_status", approvalCard()),
    ).rejects.toEqual(new FeishuMessageError(
      "invalid-response",
      "飞书消息更新响应无效",
    ));
    expect(patchMessage).toHaveBeenCalledOnce();
  });

  it("hides SDK error details from a message update", async () => {
    const patchMessage = vi.fn(async () => {
      throw new Error("Authorization: secret");
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          patchMessage,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateCard("om_status", approvalCard()),
    ).rejects.toEqual(new FeishuMessageError(
      "send-failed",
      "飞书消息更新失败",
    ));
    expect(patchMessage).toHaveBeenCalledOnce();
  });

  it("maps an SDK HTTP update timeout to the stable timeout error", async () => {
    const timeout = Object.assign(new Error("request secret"), {
      code: "ECONNABORTED",
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          patchMessage: async () => {
            throw timeout;
          },
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateCard("om_status", approvalCard()),
    ).rejects.toEqual(new FeishuMessageError(
      "send-timeout",
      "飞书消息更新超时",
    ));
  });

  it("fails with a sanitized timeout when a message update hangs", async () => {
    vi.useFakeTimers();
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 250,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          patchMessage: () => new Promise(() => {}),
          downloadResource: successfulDownload,
        }),
      },
    );

    const updating = client.updateCard(
      "om_status",
      approvalCard(),
    );
    const rejection = expect(updating).rejects.toEqual(
      new FeishuMessageError(
        "send-timeout",
        "飞书消息更新超时",
      ),
    );
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
  });

  it("stops waiting for a message when its delivery signal is aborted", async () => {
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 10_000,
        createSdkClient: () => ({
          createMessage: () => new Promise(() => {}),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );
    const controller = new AbortController();
    const sending = client.sendText("oc_chat", "queued", controller.signal);
    controller.abort();
    await expect(sending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("neutralizes platform-native mention tags in rich Markdown", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_message" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await client.sendPost(
      "oc_chat",
      "<at user_id=\"all\">所有人</at>",
    );

    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "",
            content: [[{
              tag: "md",
              text: "&lt;at user_id=\"all\">所有人&lt;/at>",
            }]],
          },
        }),
      },
    });
  });

  it("fails with a sanitized timeout when sending takes too long", async () => {
    vi.useFakeTimers();
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 250,
        createSdkClient: () => ({
          createMessage: () => new Promise(() => {}),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    const sending = client.sendText("oc_chat", "飞书回复");
    const rejection = expect(sending).rejects.toEqual(
      new FeishuMessageError(
        "send-timeout",
        "飞书消息发送超时",
      ),
    );
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
  });

  it("hides SDK error details", async () => {
    const createMessage = vi.fn(async () => {
      throw new Error("Authorization: secret");
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(client.sendText("oc_chat", "飞书回复")).rejects.toEqual(
      new FeishuMessageError(
        "send-failed",
        "飞书消息发送失败",
      ),
    );
    expect(createMessage).toHaveBeenCalledOnce();
  });

  it("maps an SDK HTTP timeout to the stable timeout error", async () => {
    const timeout = Object.assign(new Error("request secret"), {
      code: "ECONNABORTED",
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => {
            throw timeout;
          },
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(client.sendText("oc_chat", "飞书回复")).rejects.toEqual(
      new FeishuMessageError(
        "send-timeout",
        "飞书消息发送超时",
      ),
    );
  });

  it("fails closed when the SDK response has no message ID", async () => {
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: {} }),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(client.sendText("oc_chat", "飞书回复")).rejects.toEqual(
      new FeishuMessageError(
        "invalid-response",
        "飞书消息响应无效",
      ),
    );
  });

  it("downloads an image resource with the exact message and image keys", async () => {
    const stream = Readable.from([Buffer.from("image")]);
    const downloadResource = vi.fn(async () => ({
      getReadableStream: () => stream,
      headers: {
        "content-length": "5",
      },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource,
        }),
      },
    );

    await expect(
      client.downloadImage("om_message", "img_v2_resource"),
    ).resolves.toEqual({
      stream,
      contentLength: 5,
    });
    expect(downloadResource).toHaveBeenCalledWith({
      params: {
        type: "image",
      },
      path: {
        message_id: "om_message",
        file_key: "img_v2_resource",
      },
    });
  });

  it("downloads a file resource with the exact message and file keys", async () => {
    const stream = Readable.from([Buffer.from("file")]);
    const downloadResource = vi.fn(async () => ({
      getReadableStream: () => stream,
      headers: {
        "content-length": "4",
      },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource,
        }),
      },
    );

    await expect(
      client.downloadFile("om_message", "file_v2_resource"),
    ).resolves.toEqual({
      stream,
      contentLength: 4,
    });
    expect(downloadResource).toHaveBeenCalledWith({
      params: {
        type: "file",
      },
      path: {
        message_id: "om_message",
        file_key: "file_v2_resource",
      },
    });
  });

  it("reads visible text from a referenced Feishu message", async () => {
    const getMessage = vi.fn(async () => ({
      code: 0,
      data: {
        items: [{
          msg_type: "post",
          body: {
            content: JSON.stringify({
              zh_cn: {
                title: "标题",
                content: [[
                  { tag: "text", text: "原始" },
                  { tag: "a", text: "链接", href: "https://example.com" },
                ]],
              },
            }),
          },
        }],
      },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
          getMessage,
        }),
      },
    );

    await expect(client.readQuotedText("om_parent")).resolves.toBe([
      "标题",
      "原始链接 (https://example.com)",
    ].join("\n"));
    expect(getMessage).toHaveBeenCalledWith({
      params: {
        user_id_type: "open_id",
        card_msg_content_type: "raw_card_content",
      },
      path: { message_id: "om_parent" },
    });
  });

  it("reads visible text from a referenced CardKit message", async () => {
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
          getMessage: async () => ({
            code: 0,
            data: {
              items: [{
                msg_type: "interactive",
                body: {
                  content: JSON.stringify({
                    card_schema: 2,
                    json_card: JSON.stringify({
                      schema: "2.0",
                      body: {
                        elements: [
                          {
                            tag: "markdown",
                            content: "这是被引用的 **Codex 回复**。",
                          },
                          {
                            tag: "button",
                            text: {
                              tag: "plain_text",
                              content: "不要提取按钮",
                            },
                            value: {
                              interaction_token: "private-token",
                            },
                          },
                        ],
                      },
                    }),
                  }),
                },
              }],
            },
          }),
        }),
      },
    );

    await expect(client.readQuotedText("om_parent")).resolves.toBe(
      "这是被引用的 **Codex 回复**。",
    );
  });

  it("reads normalized Markdown elements from a referenced CardKit message", async () => {
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
          getMessage: async () => ({
            code: 0,
            data: {
              items: [{
                msg_type: "interactive",
                body: {
                  content: JSON.stringify({
                    card_schema: 2,
                    json_card: JSON.stringify({
                      schema: 2,
                      body: {
                        property: {
                          elements: [{
                            tag: "markdown",
                            property: {
                              elements: [
                                {
                                  tag: "text",
                                  property: { content: "规范化的 " },
                                },
                                {
                                  tag: "text",
                                  property: { content: "CardKit 正文" },
                                },
                              ],
                            },
                          }],
                        },
                      },
                    }),
                  }),
                },
              }],
            },
          }),
        }),
      },
    );

    await expect(client.readQuotedText("om_parent")).resolves.toBe(
      "规范化的 CardKit 正文",
    );
  });

  it("rejects unsafe image resource identifiers before calling the SDK", async () => {
    const downloadResource = vi.fn(successfulDownload);
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource,
        }),
      },
    );

    await expect(
      client.downloadImage("om_message", "../secret"),
    ).rejects.toEqual(new FeishuMessageError(
      "invalid-response",
      "飞书图片资源标识无效",
    ));
    expect(downloadResource).not.toHaveBeenCalled();
  });
});

async function successfulPatch(): Promise<Record<string, never>> {
  return {};
}
async function successfulDownload() {
  return {
    getReadableStream: () => Readable.from([]),
    headers: {},
  };
}

function approvalCard(): FeishuCardDocument {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "Codex 请求批准",
      },
    },
    body: { elements: [] },
  };
}
