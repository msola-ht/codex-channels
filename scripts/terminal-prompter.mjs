import { createInterface } from "node:readline/promises";

export function createPrompter(input, output) {
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  return {
    ask: async (label) => (await readline.question(`${label}：`)).trim(),
    secret: async (label) => (await readline.question(`${label}：`)).trim(),
    confirm: async (label, defaultValue) => {
      const suffix = defaultValue ? "[Y/n]" : "[y/N]";
      const value = (await readline.question(`${label} ${suffix} `)).trim().toLowerCase();
      if (!value) {
        return defaultValue;
      }
      return value === "y" || value === "yes";
    },
    close: () => readline.close(),
  };
}
