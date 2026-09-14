import {
  ConversationCommandService,
  type ConversationCommandExecutor,
  type ConversationCommandUseCases,
  type ConversationSession,
  type ConversationStatus,
  type ConversationTurnUseCases,
  type ModelOption,
  type ModelSelectionState,
  type ScheduledTaskUseCases,
} from "../src/application/index.js";

export type ConversationMethodOverrides = Partial<
  ConversationCommandUseCases & Pick<ConversationTurnUseCases, "submit">
>;

const optionalCommandMethods = new Set<PropertyKey>([
  "touchActivity",
  "backgroundThreadIds",
]);

export function conversationCommandUseCases(
  overrides: ConversationMethodOverrides,
): ConversationCommandUseCases {
  return new Proxy(overrides, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      if (optionalCommandMethods.has(property)) return undefined;
      return () => {
        throw new Error(`测试未实现会话命令能力：${String(property)}`);
      };
    },
  }) as ConversationCommandUseCases;
}

export function conversationInputUseCases(
  overrides: ConversationMethodOverrides,
): Pick<ConversationTurnUseCases, "touchActivity" | "submit"> {
  return new Proxy(overrides, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      if (property === "touchActivity") return undefined;
      return () => {
        throw new Error(`测试未实现会话输入能力：${String(property)}`);
      };
    },
  }) as Pick<ConversationTurnUseCases, "touchActivity" | "submit">;
}

export function conversationCommandExecutor(
  overrides: ConversationMethodOverrides,
  scheduledTasks?: ScheduledTaskUseCases,
): ConversationCommandExecutor {
  return new ConversationCommandService(
    conversationCommandUseCases(overrides),
    scheduledTasks,
  );
}

export function conversationStatus(
  overrides: Partial<ConversationStatus> = {},
): ConversationStatus {
  return {
    workspaceId: "main",
    workspaceName: "Main",
    cwd: "/workspace",
    model: "gpt-test",
    effort: null,
    serviceTier: null,
    modelPending: false,
    effortPending: false,
    fastModePending: false,
    collaborationMode: "default",
    collaborationModePending: false,
    ...overrides,
  };
}

export function conversationSession(
  overrides: Partial<ConversationSession> = {},
): ConversationSession {
  return {
    id: "thread-1",
    preview: "",
    name: null,
    isPinned: false,
    status: { type: "idle" },
    ...overrides,
  };
}

export function modelOption(
  overrides: Partial<ModelOption> = {},
): ModelOption {
  return {
    id: "gpt-test",
    model: "gpt-test",
    displayName: "GPT Test",
    supportedReasoningEfforts: [{ effort: "medium", description: "Medium" }],
    defaultReasoningEffort: "medium",
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
    inputModalities: ["text"],
    ...overrides,
  };
}

export function modelSelectionState(
  overrides: Partial<ModelSelectionState> = {},
): ModelSelectionState {
  return {
    models: [modelOption()],
    model: "gpt-test",
    effort: "medium",
    serviceTier: null,
    pending: false,
    modelPending: false,
    effortPending: false,
    serviceTierPending: false,
    ...overrides,
  };
}
