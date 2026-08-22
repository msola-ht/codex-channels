import type { UserInput } from "../codex-protocol/index.js";
import type { ThreadQueueInputType } from "../application/index.js";

export const maximumUserInputPreviewCharacters = 160;

export interface UserInputSummary {
  inputType: ThreadQueueInputType;
  textPreview: string | null;
  editable: boolean;
}

/** Produce a bounded summary without exposing paths or protocol payloads. */
export function summarizeUserInput(input: UserInput[]): UserInputSummary {
  if (input.length === 1) {
    const first = input[0]!;
    switch (first.type) {
      case "text":
        return { inputType: "text", textPreview: boundedUserInputText(first.text), editable: true };
      case "image":
      case "localImage":
        return { inputType: "image", textPreview: null, editable: false };
      case "audio":
      case "localAudio":
        return { inputType: "audio", textPreview: null, editable: false };
      case "skill":
        return { inputType: "skill", textPreview: null, editable: false };
      case "mention":
        return { inputType: "mention", textPreview: null, editable: false };
    }
  }
  const text = input
    .filter((item): item is Extract<UserInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join(" ");
  return {
    inputType: "other",
    textPreview: text ? boundedUserInputText(text) : null,
    editable: false,
  };
}

export function boundedUserInputText(value: string): string {
  const printable = [...value]
    .map((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f
      ? " "
      : character)
    .join("");
  const normalized = printable.replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  const characters = [...normalized];
  return characters.length > maximumUserInputPreviewCharacters
    ? `${characters.slice(0, maximumUserInputPreviewCharacters - 1).join("")}…`
    : normalized;
}
