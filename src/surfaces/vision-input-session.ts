import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import {
  imageBatchLimitError,
  surfaceActorKey,
  type SurfaceInputPart,
} from "./surface-input-batcher.js";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_SESSIONS = 1_000;
const MAXIMUM_PROMPT_LENGTH = 4_000;

interface TimedVisionState {
  prompt: string;
  timer: NodeJS.Timeout;
}

interface PendingPrompt extends TimedVisionState {
  kind: "prompt";
}

interface CollectedPart extends SurfaceInputPart {
  order: number;
}

interface PendingCollection extends TimedVisionState {
  kind: "collection";
  target: ConversationTarget;
  actorId: string;
  expectedImages?: number;
  parts: CollectedPart[];
}

type PendingVisionState = PendingPrompt | PendingCollection;

export type VisionInputDecision =
  | { kind: "pass" }
  | {
      kind: "submit";
      input: SurfaceInputPart;
      automaticCollection?: { imageCount: number; maximumImages: number };
    }
  | {
      kind: "collected";
      imageCount: number;
      maximumImages: number;
      automatic: boolean;
    };

export interface CompletedVisionCollection {
  input: SurfaceInputPart;
  imageCount: number;
}

export interface VisionInputSessionOptions {
  ttlMs?: number;
  maximumSessions?: number;
  maximumImages: number;
  maximumImageBytes: number;
}

export class VisionInputSession {
  private readonly ttlMs: number;
  private readonly maximumSessions: number;
  private readonly states = new Map<string, PendingVisionState>();
  private nextOrder = 0;
  private closed = false;

  constructor(private readonly options: VisionInputSessionOptions) {
    this.ttlMs = positiveInteger(
      options.ttlMs ?? DEFAULT_TTL_MS,
      "图片识别要求有效期无效",
    );
    this.maximumSessions = positiveInteger(
      options.maximumSessions ?? DEFAULT_MAXIMUM_SESSIONS,
      "待处理图片识别要求容量无效",
    );
  }

  setPrompt(
    target: ConversationTarget,
    actorId: string,
    value: string,
  ): { replaced: boolean } {
    this.requireOpen();
    const prompt = validatedPrompt(value);
    const key = surfaceActorKey(target, actorId);
    const previous = this.states.get(key);
    if (previous?.kind === "collection") {
      throw collectionActiveError();
    }
    this.requireCapacity(previous);
    if (previous !== undefined) clearTimeout(previous.timer);
    this.states.set(key, this.promptState(key, prompt));
    return { replaced: previous !== undefined };
  }

  beginCollection(
    target: ConversationTarget,
    actorId: string,
    value: string,
    expectedImages?: number,
  ): { replacedPrompt: boolean } {
    this.requireOpen();
    const prompt = validatedPrompt(value);
    if (
      expectedImages !== undefined
      && (
        !Number.isSafeInteger(expectedImages)
        || expectedImages < 2
        || expectedImages > this.options.maximumImages
      )
    ) {
      throw new UserFacingError(
        "vision.collection.count.invalid",
        `多图数量必须为 2 至 ${this.options.maximumImages}`,
        { maximumImages: String(this.options.maximumImages) },
      );
    }
    const key = surfaceActorKey(target, actorId);
    const previous = this.states.get(key);
    if (previous?.kind === "collection") {
      throw collectionActiveError();
    }
    this.requireCapacity(previous);
    if (previous !== undefined) clearTimeout(previous.timer);
    const state: PendingCollection = {
      kind: "collection",
      prompt,
      target,
      actorId,
      ...(expectedImages === undefined ? {} : { expectedImages }),
      parts: [],
      timer: undefined as never,
    };
    state.timer = this.expiryTimer(key, state);
    this.states.set(key, state);
    return { replacedPrompt: previous?.kind === "prompt" };
  }

  accept(input: SurfaceInputPart): VisionInputDecision {
    if ((input.localImages?.length ?? 0) === 0) {
      return { kind: "pass" };
    }
    const key = surfaceActorKey(input.target, input.actorId);
    const state = this.states.get(key);
    if (state === undefined) {
      return { kind: "pass" };
    }
    if (state.kind === "prompt") {
      clearTimeout(state.timer);
      this.states.delete(key);
      return {
        kind: "submit",
        input: {
          ...input,
          text: joinPromptAndText(state.prompt, input.text),
        },
      };
    }

    const images = [
      ...state.parts.flatMap((part) => part.localImages ?? []),
      ...(input.localImages ?? []),
    ];
    const limitError = imageBatchLimitError(
      images,
      this.options.maximumImages,
      this.options.maximumImageBytes,
    );
    if (limitError !== undefined) throw limitError;
    if (state.expectedImages !== undefined && images.length > state.expectedImages) {
      throw new UserFacingError(
        "vision.collection.count.exceeded",
        `本次只需 ${state.expectedImages} 张图片`,
        { expectedImages: String(state.expectedImages) },
      );
    }
    state.parts.push({ ...input, order: this.nextOrder });
    this.nextOrder += 1;
    clearTimeout(state.timer);
    if (state.expectedImages !== undefined && images.length === state.expectedImages) {
      return {
        kind: "submit",
        input: this.finishCollection(key, state).input,
        automaticCollection: {
          imageCount: images.length,
          maximumImages: state.expectedImages,
        },
      };
    }
    state.timer = this.expiryTimer(key, state);
    return {
      kind: "collected",
      imageCount: images.length,
      maximumImages: state.expectedImages ?? this.options.maximumImages,
      automatic: state.expectedImages !== undefined,
    };
  }

  complete(
    target: ConversationTarget,
    actorId: string,
  ): CompletedVisionCollection {
    this.requireOpen();
    const key = surfaceActorKey(target, actorId);
    const state = this.states.get(key);
    if (state?.kind !== "collection") {
      throw new UserFacingError(
        "vision.collection.missing",
        "当前没有进行中的多图收集",
      );
    }
    if (state.parts.length === 0) {
      throw new UserFacingError(
        "vision.collection.empty",
        "请先发送至少一张图片",
      );
    }
    return this.finishCollection(key, state);
  }

  private finishCollection(
    key: string,
    state: PendingCollection,
  ): CompletedVisionCollection {
    clearTimeout(state.timer);
    this.states.delete(key);
    const parts = [...state.parts].sort(
      (left, right) => left.sequence - right.sequence || left.order - right.order,
    );
    const localImages = parts.flatMap((part) => part.localImages ?? []);
    const text = [
      state.prompt,
      ...parts.flatMap((part) => part.text === undefined ? [] : [part.text]),
    ].join("\n\n");
    return {
      imageCount: localImages.length,
      input: {
        target: state.target,
        actorId: state.actorId,
        sequence: parts[0]!.sequence,
        text,
        localImages,
      },
    };
  }

  cancel(target: ConversationTarget, actorId: string): boolean {
    const key = surfaceActorKey(target, actorId);
    const state = this.states.get(key);
    if (state === undefined) return false;
    clearTimeout(state.timer);
    this.states.delete(key);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.states.values()) clearTimeout(state.timer);
    this.states.clear();
  }

  private promptState(key: string, prompt: string): PendingPrompt {
    const state: PendingPrompt = {
      kind: "prompt",
      prompt,
      timer: undefined as never,
    };
    state.timer = this.expiryTimer(key, state);
    return state;
  }

  private expiryTimer(key: string, state: PendingVisionState): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.states.get(key) === state) this.states.delete(key);
    }, this.ttlMs);
    timer.unref();
    return timer;
  }

  private requireCapacity(previous: PendingVisionState | undefined): void {
    if (previous === undefined && this.states.size >= this.maximumSessions) {
      throw new UserFacingError(
        "vision.prompt.capacity",
        "待处理的图片识别要求已满",
      );
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("输入聚合器已关闭");
  }
}

function validatedPrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || prompt.length > MAXIMUM_PROMPT_LENGTH) {
    throw new UserFacingError(
      "vision.prompt.invalid",
      "图片识别要求必须为 1 至 4000 个字符",
    );
  }
  return prompt;
}

function collectionActiveError(): UserFacingError {
  return new UserFacingError(
    "vision.collection.active",
    "当前正在收集多张图片，请先完成或取消",
  );
}

function joinPromptAndText(prompt: string, text: string | undefined): string {
  const value = text?.trim();
  return value ? `${prompt}\n\n${value}` : prompt;
}

function positiveInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}
