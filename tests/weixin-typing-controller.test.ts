import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SurfaceAccessPolicy } from "../src/policy/index.js";
import {
  WeixinProtocolError,
  WeixinReplyContextStore,
  WeixinTypingController,
  type WeixinTypingProtocolClient,
} from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";
const actorId = "actor-fixture@im.wechat";
const target = {
  surface: "weixin",
  accountId,
  conversationId: actorId,
} as const;

describe("WeixinTypingController", () => {
  it("starts, renews every five seconds, cancels and reuses the memory ticket", async () => {
    const contexts = new WeixinReplyContextStore(accountId);
    contexts.remember(target, actorId, "context-secret");
    const getTypingTicket = vi.fn(async () => "private-ticket");
    const setTyping = vi.fn<WeixinTypingProtocolClient["setTyping"]>(
      async () => {},
    );
    const delays = delayFixture();
    const controller = new WeixinTypingController(
      { getTypingTicket, setTyping },
      contexts,
      accessFixture(true),
      pino({ level: "silent" }),
      { delayImpl: delays.wait },
    );

    controller.start(target);
    await vi.waitFor(() => {
      expect(setTyping).toHaveBeenCalledOnce();
    });
    expect(getTypingTicket).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
    }, expect.any(AbortSignal));
    expect(delays.wait).toHaveBeenCalledWith(
      5_000,
      expect.any(AbortSignal),
    );

    delays.release();
    await vi.waitFor(() => {
      expect(setTyping).toHaveBeenCalledTimes(2);
    });
    await controller.stop(target);

    controller.start(target);
    await vi.waitFor(() => {
      expect(setTyping).toHaveBeenCalledTimes(4);
    });
    await controller.stop(target);
    await controller.close();

    expect(getTypingTicket).toHaveBeenCalledOnce();
    expect(setTyping.mock.calls.map(([input]) => input.status)).toEqual([
      "typing",
      "typing",
      "cancel",
      "typing",
      "cancel",
    ]);
  });

  it("isolates typing failures from replies and logs no ticket or context", async () => {
    let logs = "";
    const destination = {
      write(message: string) {
        logs += message;
      },
    };
    const contexts = new WeixinReplyContextStore(accountId);
    contexts.remember(target, actorId, "context-secret");
    const controller = new WeixinTypingController(
      {
        getTypingTicket: vi.fn(async () => "private-ticket"),
        setTyping: vi.fn(async () => {
          throw new WeixinProtocolError(
            "api-error",
            "private-ticket context-secret",
            undefined,
            -14,
          );
        }),
      },
      contexts,
      accessFixture(true),
      pino({}, destination),
    );

    controller.start(target);
    await vi.waitFor(() => {
      expect(logs).toContain('"errorCode":"api-error"');
    });
    await controller.stop(target);

    expect(logs).toContain('"returnCode":-14');
    expect(logs).not.toContain("private-ticket");
    expect(logs).not.toContain("context-secret");
  });

  it("does not start for a missing or revoked reply context", async () => {
    const contexts = new WeixinReplyContextStore(accountId);
    const client = {
      getTypingTicket: vi.fn(async () => "private-ticket"),
      setTyping: vi.fn(async () => {}),
    };
    const controller = new WeixinTypingController(
      client,
      contexts,
      accessFixture(false),
      pino({ level: "silent" }),
    );

    controller.start(target);
    await controller.stop(target);
    contexts.remember(target, actorId, "context-secret");
    controller.start(target);
    await controller.stop(target);

    expect(client.getTypingTicket).not.toHaveBeenCalled();
    expect(client.setTyping).not.toHaveBeenCalled();
  });
});

function accessFixture(allowed: boolean): SurfaceAccessPolicy {
  return {
    isAllowed: vi.fn(() => allowed),
  };
}

function delayFixture() {
  let releaseCurrent: (() => void) | undefined;
  const wait = vi.fn(
    (_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          const error = new WeixinProtocolError(
            "aborted",
            "微信输入状态已取消",
          );
          reject(error);
        };
        signal.addEventListener("abort", abort, { once: true });
        releaseCurrent = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
      }),
  );
  return {
    wait,
    release() {
      const release = releaseCurrent;
      releaseCurrent = undefined;
      release?.();
    },
  };
}
