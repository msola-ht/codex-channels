import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const nodeGlobals = Object.fromEntries([
  "AbortController",
  "Buffer",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "URL",
  "URLSearchParams",
  "clearInterval",
  "clearTimeout",
  "console",
  "fetch",
  "performance",
  "process",
  "setInterval",
  "setTimeout",
  "structuredClone",
].map((name) => [name, "readonly"]));

export default defineConfig(
  {
    files: [
      "src/**/*.ts",
    ],
    ignores: [
      "src/codex-protocol/generated/**",
    ],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: [
      "tests/**/*.ts",
    ],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
    ],
  },
  {
    files: [
      "bin/**/*.mjs",
      "runtime/**/*.mjs",
      "scripts/**/*.mjs",
    ],
    extends: [
      eslint.configs.recommended,
    ],
    languageOptions: {
      globals: nodeGlobals,
      sourceType: "module",
    },
  },
);
