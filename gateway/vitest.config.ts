import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["gateway/tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
