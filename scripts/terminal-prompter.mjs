import { createInterface } from "node:readline/promises";

export function createPrompter(input, output) {
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  return {
    ask: async (label, options) =>
      (await readline.question(`${label}：`, options)).trim(),
    secret: async (label, options) =>
      (await readline.question(`${label}：`, options)).trim(),
    confirm: async (label, defaultValue, options) => {
      const suffix = defaultValue ? "[Y/n]" : "[y/N]";
      const value = (await readline.question(`${label} ${suffix} `, options))
        .trim()
        .toLowerCase();
      if (!value) {
        return defaultValue;
      }
      return value === "y" || value === "yes";
    },
    close: () => readline.close(),
  };
}
