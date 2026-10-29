import type { UserInput } from "../codex-protocol/index.js";
import type { ThreadHistoryInputType } from "../application/index.js";

export const maximumUserInputPreviewCharacters = 160;

export interface UserInputSummary {
  inputType: ThreadHistoryInputType;
  textPreview: string | null;
}

/** Produce a bounded summary without exposing paths or protocol payloads. */
export function summarizeUserInput(input: UserInput[]): UserInputSummary {
  if (input.length === 1) {
    const first = input[0]!;
    switch (first.type) {
      case "text":
        return { inputType: "text", textPreview: boundedUserInputText(first.text) };
      case "image":
      case "localImage":
        return { inputType: "image", textPreview: null };
      case "audio":
      case "localAudio":
        return { inputType: "audio", textPreview: null };
      case "skill":
        return { inputType: "skill", textPreview: null };
      case "mention":
        return { inputType: "mention", textPreview: null };
    }
  }
  const text = input
    .filter((item): item is Extract<UserInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join(" ");
  return {
    inputType: "other",
    textPreview: text ? boundedUserInputText(text) : null,
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
