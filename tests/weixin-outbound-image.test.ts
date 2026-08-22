import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  maximumWeixinOutboundImageBytes,
  readWeixinOutboundImage,
} from "../src/surfaces/weixin/index.js";

describe("Weixin outbound generated-image reader", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codexc-weixin-output-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reads bounded regular PNG and JPEG files", async () => {
    const pngPath = join(directory, "image.png");
    const png = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x01,
    ]);
    const jpegPath = join(directory, "image.jpg");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    await writeFile(pngPath, png);
    await writeFile(jpegPath, jpeg);

    await expect(readWeixinOutboundImage(pngPath)).resolves.toEqual(png);
    await expect(readWeixinOutboundImage(jpegPath)).resolves.toEqual(jpeg);
  });

  it("rejects relative paths, symbolic links and unsupported files", async () => {
    const imagePath = join(directory, "image.png");
    const linkPath = join(directory, "link.png");
    const textPath = join(directory, "text.txt");
    const webpPath = join(directory, "image.webp");
    await writeFile(imagePath, Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]));
    await symlink(imagePath, linkPath);
    await writeFile(textPath, "private text");
    await writeFile(webpPath, Buffer.from("524946460400000057454250", "hex"));

    await expect(readWeixinOutboundImage("relative.png"))
      .rejects.toMatchObject({ code: "invalid-path" });
    await expect(readWeixinOutboundImage(linkPath))
      .rejects.toMatchObject({ code: "invalid-file" });
    await expect(readWeixinOutboundImage(textPath))
      .rejects.toMatchObject({ code: "unsupported-image" });
    await expect(readWeixinOutboundImage(webpPath))
      .rejects.toMatchObject({ code: "unsupported-image" });
  });

  it("rejects files above the shared 10 MiB output boundary", async () => {
    const imagePath = join(directory, "oversized.png");
    const image = Buffer.alloc(maximumWeixinOutboundImageBytes + 1);
    Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]).copy(image);
    await writeFile(imagePath, image);

    await expect(readWeixinOutboundImage(imagePath))
      .rejects.toMatchObject({ code: "too-large" });
  });
});
