import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { splitFeishuText } from "../src/surfaces/feishu/outbox-content.js";
import { splitTelegramText } from "../src/surfaces/telegram/format.js";
import { formatWeixinFinalText } from "../src/surfaces/weixin/final-text-format.js";

describe("Surface 文本格式属性", () => {
  it("Telegram 分片不拆散 Unicode 码点且不丢失无换行正文", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 2_000 }).map((value) =>
          value.replaceAll("\n", "")
        ),
        fc.integer({ min: 1, max: 200 }),
        (text, limit) => {
          const chunks = splitTelegramText(text, limit);

          expect(chunks.join("")).toBe(text);
          expect(chunks.every((chunk) => [...chunk].length <= limit)).toBe(true);
          expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("飞书分片始终满足消息字节与数量上限", () => {
    const text = fc.oneof(
      fc.string({ maxLength: 5_000 }),
      fc.tuple(
        fc.constantFrom("a", "测", "😀", "\n"),
        fc.integer({ min: 0, max: 25_000 }),
      ).map(([character, count]) => character.repeat(count)),
    );

    fc.assert(
      fc.property(text, (value) => {
        const chunks = splitFeishuText(value);

        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks.length).toBeLessThanOrEqual(5);
        expect(
          chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 20_000),
        ).toBe(true);
        if (Buffer.byteLength(value, "utf8") <= 20_000) {
          expect(chunks).toEqual([value]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("微信最终文本格式化重复执行不会继续改变结果", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5_000 }), (text) => {
        const formatted = formatWeixinFinalText(text);

        expect(formatWeixinFinalText(formatted)).toBe(formatted);
      }),
      { numRuns: 300 },
    );
  });
});
