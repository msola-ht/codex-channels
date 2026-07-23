import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({
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
});
