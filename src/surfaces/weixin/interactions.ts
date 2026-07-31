import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import {
  resolveApprovalChoice,
  safeInteractionDecision,
  type ApprovalChoice,
  type InteractionDecision,
  type InteractionPort,
  type InteractionRequest,
} from "../../approval/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";
import {
  formatCancelledInteraction,
  formatProcessedInteractionOutcome,
  interactionOutcome,
} from "../interaction-copy.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import { PendingInteractionRegistry } from "../pending-interaction-registry.js";
import { sanitizeWeixinMarkdownText } from "./operation-format.js";

type ApprovalRequest = Extract<InteractionRequest, { type: "approval" }>;
type UserInputRequest = Extract<InteractionRequest, { type: "user-input" }>;
type ElicitationRequest = Extract<InteractionRequest, { type: "elicitation" }>;

interface WeixinInteractionDelivery {
  deliverText(target: ConversationTarget, text: string): Promise<void>;
  deliverTextSequence(
    target: ConversationTarget,
    texts: readonly string[],
  ): Promise<void>;
}

interface PendingInteraction {
  requestId: string;
  target: ConversationTarget;
  actorId: string;
  request: InteractionRequest;
  answers: Map<string, string[]>;
  questionIndex: number;
  resolve(decision: InteractionDecision): void;
  timer: NodeJS.Timeout;
}

export type WeixinInteractionTextResult = "handled" | "not-command";

const maximumPromptCharacters = 16_000;
const maximumPromptMessageCharacters = 4_000;
const maximumQuestionCount = 3;
const maximumInputCharacters = 1_000;
const interactionTokenPattern = /^[A-Za-z0-9_-]{8,64}$/;

export class WeixinInteractionPort implements InteractionPort {
  private readonly pending = new PendingInteractionRegistry<PendingInteraction>();
  private closed = false;

  constructor(
    private readonly delivery?: WeixinInteractionDelivery,
    private readonly actorRegistry?: ConversationActorRegistry,
    private readonly access?: SurfaceAccessPolicy,
    private readonly logger?: Logger,
    private readonly createToken = () => randomBytes(12).toString("base64url"),
  ) {}

  request(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    if (!supportsInteraction(request)) {
      if (
        !this.closed && request.type === "user-input"
        && request.questions.some((question) => question.secret)
      ) {
        void this.notify(
          target,
          "微信聊天无法安全填写敏感信息，本次输入请求已取消。",
        );
      }
      return Promise.resolve(safeInteractionDecision(request));
    }
    return this.requestInteraction(target, request);
  }

  async handleText(
    target: ConversationTarget,
    actorId: string,
    text: string,
  ): Promise<WeixinInteractionTextResult> {
    const command = parseInteractionCommand(text);
    if (command === null) {
      return "not-command";
    }
    if (command === "invalid") {
      await this.notify(target, "交互命令格式无效，请复制提示中的完整命令。");
      return "handled";
    }
    const pending = this.pending.get(command.token);
    if (!pending) {
      await this.notify(target, "交互请求不存在、已过期或已处理。");
      return "handled";
    }
    if (
      this.closed
      || !sameTarget(target, pending.target)
      || actorId !== pending.actorId
      || !this.access?.isAllowed({ target, actorId })
    ) {
      await this.notify(target, "交互命令与当前账号或会话不匹配。");
      return "handled";
    }
    await this.handleCommand(command.token, pending, command);
    return "handled";
  }

  resolved(requestId: string): void {
    const resolution = this.pending.resolved(requestId);
    if (!resolution?.pending) {
      return;
    }
    void this.finish(
      resolution.token,
      safeInteractionDecision(resolution.pending.request),
      formatProcessedInteractionOutcome(interactionOutcome.resolvedElsewhere),
    );
  }

  cancelAll(outcome = "Gateway 已停止"): void {
    for (const [token, pending] of this.pending.entries()) {
      void this.finish(
        token,
        safeInteractionDecision(pending.request),
        formatCancelledInteraction(outcome),
      );
    }
  }

  close(): void {
    this.closed = true;
    this.cancelAll("Gateway 已停止");
  }

  private async requestInteraction(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    if (
      this.closed
      || !this.delivery
      || !this.actorRegistry
      || !this.access
    ) {
      return safeInteractionDecision(request);
    }
    const actors = this.actorRegistry.actors(target).filter(
      (actorId) => this.access!.isAllowed({ target, actorId }),
    );
    if (actors.length !== 1) {
      return safeInteractionDecision(request);
    }
    const token = this.createToken();
    if (!interactionTokenPattern.test(token)) {
      return safeInteractionDecision(request);
    }
    if (!this.pending.reserve(request.requestId, token)) {
      return safeInteractionDecision(request);
    }
    const prompt = renderInteractionPrompt(request, token);
    const promptCharacters = request.type === "user-input"
      ? request.questions.reduce(
          (length, _question, index) =>
            length
            + renderUserInputPrompt(
              request,
              token,
              index,
              index === 0,
            ).reduce(
              (messageLength, message) => messageLength + message.length,
              0,
            ),
          0,
        )
      : prompt.reduce((length, message) => length + message.length, 0);
    if (
      promptCharacters > maximumPromptCharacters
    ) {
      this.pending.release(request.requestId, token);
      await this.notify(target, "交互详情过长，微信端已安全取消本次请求。");
      return safeInteractionDecision(request);
    }

    let resolveDecision!: (decision: InteractionDecision) => void;
    const decision = new Promise<InteractionDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const timer = setTimeout(() => {
      void this.finish(
        token,
        safeInteractionDecision(request),
        formatProcessedInteractionOutcome(interactionOutcome.timedOut),
      );
    }, request.expiresInMs);
    timer.unref();
    const activation = this.pending.activate(token, {
      requestId: request.requestId,
      target,
      actorId: actors[0]!,
      request,
      answers: new Map(),
      questionIndex: 0,
      resolve: resolveDecision,
      timer,
    });
    if (activation === "missing") {
      clearTimeout(timer);
      return safeInteractionDecision(request);
    }

    try {
      await this.delivery.deliverTextSequence(target, prompt);
    } catch (error) {
      await this.finish(
        token,
        safeInteractionDecision(request),
      );
      this.logger?.warn(
        {
          requestId: request.requestId,
          requestType: request.type,
          threadId: request.threadId,
          turnId: request.turnId,
          surface: target.surface,
          accountId: target.accountId,
          conversationId: target.conversationId,
          ...surfaceErrorMetadata(error),
        },
        "微信交互请求发送失败",
      );
      throw error;
    }
    this.logger?.info(
      {
        requestId: request.requestId,
        requestType: request.type,
        threadId: request.threadId,
        turnId: request.turnId,
        surface: target.surface,
        accountId: target.accountId,
        conversationId: target.conversationId,
      },
      "微信交互请求已送达",
    );
    return decision;
  }

  private async handleCommand(
    token: string,
    pending: PendingInteraction,
    command: ParsedInteractionCommand,
  ): Promise<void> {
    if (command.action === "cancel") {
      await this.finish(
        token,
        safeInteractionDecision(pending.request),
        interactionCancelledOutcome(),
      );
      return;
    }
    if (pending.request.type === "approval") {
      const choice = approvalChoice(command);
      const resolution = choice === undefined
        ? undefined
        : resolveApprovalChoice(pending.request, choice);
      if (!resolution) {
        await this.notify(pending.target, "该审批选项未由当前请求提供。");
        return;
      }
      await this.finish(
        token,
        resolution.decision,
        formatProcessedInteractionOutcome(resolution.outcome),
      );
      return;
    }
    if (pending.request.type === "user-input") {
      await this.handleUserInputCommand(
        token,
        pending,
        pending.request,
        command,
      );
      return;
    }
    await this.handleElicitationCommand(
      token,
      pending,
      pending.request,
      command,
    );
  }

  private async handleUserInputCommand(
    token: string,
    pending: PendingInteraction,
    request: UserInputRequest,
    command: ParsedInteractionCommand,
  ): Promise<void> {
    if (command.action !== "select" && command.action !== "answer") {
      await this.notify(pending.target, "该命令不适用于当前输入请求。");
      return;
    }
    if (command.questionNumber - 1 !== pending.questionIndex) {
      await this.notify(
        pending.target,
        `请先回答第 ${pending.questionIndex + 1} 项。`,
      );
      return;
    }
    const question = request.questions[command.questionNumber - 1];
    if (!question) {
      await this.notify(pending.target, "问题序号不在当前请求范围内。");
      return;
    }
    const answer = command.action === "select"
      ? question.options[command.optionNumber - 1]
      : command.answer.trim();
    if (
      answer === undefined
      || answer.length === 0
      || answer.length > maximumInputCharacters
      || (
        command.action === "answer"
        && question.options.length > 0
        && !question.allowOther
      )
    ) {
      await this.notify(pending.target, "回答无效，请使用当前问题提供的命令。");
      return;
    }
    pending.answers.set(question.id, [answer]);
    if (
      pending.answers.size !== request.questions.length
    ) {
      const next = request.questions.findIndex(
        (candidate) => !pending.answers.has(candidate.id),
      );
      pending.questionIndex = next;
      try {
        await this.delivery?.deliverTextSequence(
          pending.target,
          renderUserInputPrompt(request, token, next, false),
        );
      } catch (error) {
        this.logger?.warn(
          {
            requestId: pending.requestId,
            requestType: request.type,
            threadId: request.threadId,
            turnId: request.turnId,
            surface: pending.target.surface,
            accountId: pending.target.accountId,
            conversationId: pending.target.conversationId,
            ...surfaceErrorMetadata(error),
          },
          "微信下一项输入请求发送失败",
        );
        await this.finish(
          token,
          safeInteractionDecision(request),
          formatProcessedInteractionOutcome(interactionOutcome.userInputFailed),
        );
      }
      return;
    }
    await this.finish(
      token,
      {
        type: "user-input",
        answers: Object.fromEntries(pending.answers),
      },
      formatProcessedInteractionOutcome(interactionOutcome.answered),
    );
  }

  private async handleElicitationCommand(
    token: string,
    pending: PendingInteraction,
    request: ElicitationRequest,
    command: ParsedInteractionCommand,
  ): Promise<void> {
    if (
      request.mode === "url"
      && command.action === "complete"
    ) {
      await this.finish(
        token,
        { type: "elicitation", action: "accept", content: null },
        formatProcessedInteractionOutcome(interactionOutcome.completed),
      );
      return;
    }
    if (
      request.mode === "form"
      && command.action === "submit-form"
      && command.content.length <= maximumInputCharacters
    ) {
      try {
        const content = JSON.parse(command.content) as unknown;
        await this.finish(
          token,
          { type: "elicitation", action: "accept", content },
          formatProcessedInteractionOutcome(interactionOutcome.formSubmitted),
        );
        return;
      } catch {
        // 下面返回稳定提示，不暴露用户表单内容。
      }
    }
    if (
      request.mode === "tool-approval"
      && command.action === "approve"
    ) {
      const scope = command.scope === "once"
        ? "once"
        : command.scope === "session" && request.toolApproval?.allowSession
          ? "session"
          : command.scope === "always" && request.toolApproval?.allowAlways
            ? "always"
            : undefined;
      if (scope) {
        await this.finish(
          token,
          {
            type: "elicitation",
            action: "accept",
            content: null,
            scope,
          },
          formatProcessedInteractionOutcome(
            scope === "session"
              ? interactionOutcome.mcpAllowedSession
              : scope === "always"
                ? interactionOutcome.mcpAllowedAlways
                : interactionOutcome.mcpAllowedOnce,
          ),
        );
        return;
      }
    }
    await this.notify(pending.target, "MCP 交互命令或内容无效。");
  }

  private async finish(
    token: string,
    decision: InteractionDecision,
    outcome?: string,
  ): Promise<void> {
    const pending = this.pending.take(token);
    if (!pending) {
      return;
    }
    pending.resolve(decision);
    if (outcome !== undefined) {
      await this.notify(pending.target, outcome);
    }
  }

  private async notify(
    target: ConversationTarget,
    text: string,
  ): Promise<void> {
    try {
      await this.delivery?.deliverText(target, text);
    } catch (error) {
      this.logger?.warn(
        {
          surface: target.surface,
          accountId: target.accountId,
          conversationId: target.conversationId,
          ...surfaceErrorMetadata(error),
        },
        "微信交互状态发送失败",
      );
    }
  }
}

type ParsedInteractionCommand =
  | { action: "deny"; token: string }
  | {
      action: "approve";
      token: string;
      scope: "once" | "session" | "always" | "rule";
    }
  | {
      action: "approve";
      token: string;
      scope: "network";
      amendmentNumber: number;
    }
  | { action: "cancel"; token: string }
  | {
      action: "select";
      token: string;
      questionNumber: number;
      optionNumber: number;
    }
  | {
      action: "answer";
      token: string;
      questionNumber: number;
      answer: string;
    }
  | { action: "submit-form"; token: string; content: string }
  | { action: "complete"; token: string };

function parseInteractionCommand(
  text: string,
): ParsedInteractionCommand | "invalid" | null {
  const normalized = text.trim();
  if (
    !/^\/(?:批准一次|批准会话|始终允许|保存命令规则|保存网络规则|拒绝|取消|选择|填写|提交表单|完成)(?:\s|$)/u
      .test(normalized)
  ) {
    return null;
  }
  const parts = normalized.split(/\s+/u);
  if (
    (parts[0] === "/取消" || parts[0] === "/完成")
    && parts.length === 2
    && interactionTokenPattern.test(parts[1]!)
  ) {
    return {
      action: parts[0] === "/取消" ? "cancel" : "complete",
      token: parts[1]!,
    };
  }
  if (
    parts[0] === "/选择"
    && parts.length === 4
    && interactionTokenPattern.test(parts[1]!)
    && positiveNumber(parts[2]!)
    && positiveNumber(parts[3]!)
  ) {
    return {
      action: "select",
      token: parts[1]!,
      questionNumber: Number(parts[2]),
      optionNumber: Number(parts[3]),
    };
  }
  const answerMatch = normalized.match(
    /^\/填写\s+([A-Za-z0-9_-]{8,64})\s+([1-9]\d*)\s+([\s\S]+)$/u,
  );
  if (answerMatch) {
    return {
      action: "answer",
      token: answerMatch[1]!,
      questionNumber: Number(answerMatch[2]),
      answer: answerMatch[3]!,
    };
  }
  const formMatch = normalized.match(
    /^\/提交表单\s+([A-Za-z0-9_-]{8,64})\s+([\s\S]+)$/u,
  );
  if (formMatch) {
    return {
      action: "submit-form",
      token: formMatch[1]!,
      content: formMatch[2]!,
    };
  }
  if (
    parts[0] === "/拒绝"
    && parts.length === 2
    && interactionTokenPattern.test(parts[1]!)
  ) {
    return { action: "deny", token: parts[1]! };
  }
  if (
    !interactionTokenPattern.test(parts[1] ?? "")
  ) {
    return "invalid";
  }
  if (
    parts.length === 2
    && (
      parts[0] === "/批准一次"
      || parts[0] === "/批准会话"
      || parts[0] === "/始终允许"
      || parts[0] === "/保存命令规则"
    )
  ) {
    return {
      action: "approve",
      token: parts[1]!,
      scope: parts[0] === "/批准一次"
        ? "once"
        : parts[0] === "/批准会话"
          ? "session"
          : parts[0] === "/始终允许" ? "always" : "rule",
    };
  }
  if (
    parts.length === 3
    && parts[0] === "/保存网络规则"
    && /^[1-9]\d*$/u.test(parts[2]!)
  ) {
    return {
      action: "approve",
      token: parts[1]!,
      scope: "network",
      amendmentNumber: Number(parts[2]),
    };
  }
  return "invalid";
}

function approvalChoice(
  command: ParsedInteractionCommand,
): ApprovalChoice | undefined {
  if (command.action === "deny") {
    return { type: "reject" };
  }
  if (command.action !== "approve") {
    return undefined;
  }
  switch (command.scope) {
    case "once":
      return { type: "once" };
    case "session":
      return { type: "session" };
    case "rule":
      return { type: "execpolicy" };
    case "always":
      return undefined;
    case "network":
      return Number.isSafeInteger(command.amendmentNumber)
        ? {
            type: "networkpolicy",
            amendmentIndex: command.amendmentNumber - 1,
          }
        : undefined;
  }
}

function supportsInteraction(request: InteractionRequest): boolean {
  if (request.type === "approval") {
    return true;
  }
  if (request.type === "user-input") {
    return request.questions.length > 0
      && request.questions.length <= maximumQuestionCount
      && !request.questions.some((question) => question.secret)
      && new Set(request.questions.map((question) => question.id)).size
        === request.questions.length;
  }
  return request.mode === "form"
    || (request.mode === "tool-approval" && request.toolApproval !== undefined)
    || (
      request.url !== undefined
      && safeHttpUrl(request.url) !== undefined
    );
}

function renderInteractionPrompt(
  request: InteractionRequest,
  token: string,
): readonly string[] {
  switch (request.type) {
    case "approval":
      return renderApprovalPrompt(request, token);
    case "user-input":
      return renderUserInputPrompt(request, token, 0, true);
    case "elicitation":
      return renderElicitationPrompt(request, token);
  }
}

function renderApprovalPrompt(
  request: ApprovalRequest,
  token: string,
): readonly string[] {
  const choices = [
    { label: "批准一次", command: `/批准一次 ${token}` },
    ...(request.allowSession
      ? [{ label: "批准当前会话", command: `/批准会话 ${token}` }]
      : []),
    ...(request.execPolicyAmendment
      ? [{ label: "保存命令规则", command: `/保存命令规则 ${token}` }]
      : []),
    ...(request.networkPolicyAmendments ?? []).map(
      (_amendment, index) => ({
        label: `保存网络规则 ${index + 1}`,
        command: `/保存网络规则 ${token} ${index + 1}`,
      }),
    ),
    { label: "拒绝", command: `/拒绝 ${token}` },
  ];
  return [
    [
      sanitizeWeixinMarkdownText(request.title),
      "审批内容（仅供核对，不是操作命令）：",
      sanitizeWeixinMarkdownText(request.detail),
      `有效期：${Math.max(1, Math.ceil(request.expiresInMs / 1_000))} 秒`,
      "请完整复制并发送以下一条命令。",
      "普通数字、“同意”或修改后的命令不会批准。",
    ].join("\n\n"),
    ...packApprovalChoiceMessages(choices),
  ];
}

function packApprovalChoiceMessages(
  choices: readonly { label: string; command: string }[],
): string[] {
  const messages: string[] = [];
  let current = "";
  for (const choice of choices) {
    const block = [
      choice.label,
      `\`\`\`text\n${choice.command}\n\`\`\``,
    ].join("\n\n");
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
    if (
      current.length > 0
      && candidate.length > maximumPromptMessageCharacters
    ) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    messages.push(current);
  }
  return messages;
}

function renderUserInputPrompt(
  request: UserInputRequest,
  token: string,
  questionIndex: number,
  includeIntroduction: boolean,
): readonly string[] {
  const introduction = [
    sanitizeWeixinMarkdownText(request.title),
    "Codex 正在等待你的回答。每个问题只接受一项答案。",
    `有效期：${Math.max(1, Math.ceil(request.expiresInMs / 1_000))} 秒`,
  ].join("\n\n");
  const question = request.questions[questionIndex]!;
  const number = questionIndex + 1;
  const description = [
    `问题 ${number}/${request.questions.length}：${
      sanitizeWeixinMarkdownText(question.header)
    }`,
    sanitizeWeixinMarkdownText(question.question),
  ].join("\n");
  const choices = question.options.map((option, optionIndex) => [
    `${optionIndex + 1}. ${sanitizeWeixinMarkdownText(option)}`,
    `\`\`\`text\n/选择 ${token} ${number} ${optionIndex + 1}\n\`\`\``,
  ].join("\n"));
  const other = question.allowOther || question.options.length === 0
    ? [[
        "填写其他内容（复制后替换最后的文字）：",
        `\`\`\`text\n/填写 ${token} ${number} 在这里输入答案\n\`\`\``,
      ].join("\n")]
    : [];
  return [
    ...(includeIntroduction ? [introduction] : []),
    ...packPromptBlocks([
      description,
      ...choices,
      ...other,
      [
        "取消本次输入：",
        `\`\`\`text\n/取消 ${token}\n\`\`\``,
      ].join("\n"),
    ]),
  ];
}

function renderElicitationPrompt(
  request: ElicitationRequest,
  token: string,
): readonly string[] {
  const introduction = [
    sanitizeWeixinMarkdownText(request.title),
    sanitizeWeixinMarkdownText(request.message),
    `有效期：${Math.max(1, Math.ceil(request.expiresInMs / 1_000))} 秒`,
  ].join("\n\n");
  const action = request.mode === "url"
    ? [
        `请在浏览器打开：${safeHttpUrl(request.url!)}`,
        "完成外部操作后发送：",
        `\`\`\`text\n/完成 ${token}\n\`\`\``,
      ].join("\n\n")
    : request.mode === "tool-approval" && request.toolApproval
      ? renderMcpToolApprovalActions(request, token)
      : [
        "请提交不超过 1000 字符的有效 JSON（复制后替换示例内容）：",
        `\`\`\`text\n/提交表单 ${token} {"key":"value"}\n\`\`\``,
      ].join("\n\n");
  return [
    introduction,
    ...packPromptBlocks([
      action,
      [
        "取消本次交互：",
        `\`\`\`text\n/取消 ${token}\n\`\`\``,
      ].join("\n"),
    ]),
  ];
}

function renderMcpToolApprovalActions(
  request: ElicitationRequest,
  token: string,
): string {
  const tool = request.toolApproval!;
  return [
    `工具：${sanitizeWeixinMarkdownText(tool.toolTitle ?? "未命名工具")}`,
    ...(tool.detail
      ? [`参数：${sanitizeWeixinMarkdownText(tool.detail)}`]
      : []),
    "请完整复制并发送以下一条命令。",
    "允许一次",
    `\`\`\`text\n/批准一次 ${token}\n\`\`\``,
    ...(tool.allowSession
      ? [
          "本会话允许",
          `\`\`\`text\n/批准会话 ${token}\n\`\`\``,
        ]
      : []),
    ...(tool.allowAlways
      ? [
          "始终允许",
          `\`\`\`text\n/始终允许 ${token}\n\`\`\``,
        ]
      : []),
  ].join("\n\n");
}

function packPromptBlocks(blocks: readonly string[]): string[] {
  const messages: string[] = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
    if (
      current.length > 0
      && candidate.length > maximumPromptMessageCharacters
    ) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    messages.push(current);
  }
  return messages;
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function positiveNumber(value: string): boolean {
  return /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value));
}

function interactionCancelledOutcome(): string {
  return formatCancelledInteraction();
}

function sameTarget(
  left: ConversationTarget,
  right: ConversationTarget,
): boolean {
  return left.surface === right.surface
    && left.accountId === right.accountId
    && left.conversationId === right.conversationId;
}
