import { expect, it } from "vitest";
import { formatDisplayedProvider, scopedModelDisplayName } from "../src/surfaces/provider-format.js";

it.each([
  ["DeepSeek · V4", "deepseek", "V4"],
  ["deepseek · V4", "deepseek", "V4"],
  ["custom-main · Model", "custom-main", "Model"],
  ["DeepSeek · V4", undefined, "DeepSeek · V4"],
  ["DeepSeek · V4", "", "DeepSeek · V4"],
  ["DeepSeek · V4", "openai", "DeepSeek · V4"],
  ["DeepSeek V4", "deepseek", "DeepSeek V4"],
  ["DeepSeek · DeepSeek · V4", "deepseek", "DeepSeek · V4"],
])("scopes model display %s to provider %s without changing other text", (name, provider, expected) => {
  expect(scopedModelDisplayName(name!, provider)).toBe(expected);
});

it.each(["openai", "deepseek", "custom-main"])("preserves the command provider identity %s", provider => {
  expect(formatDisplayedProvider(provider)).toBe(provider);
});
