import { registerCodexcCliTests } from "./codexc-cli-suite.js";
import { describe, it } from "vitest";

if (process.platform === "win32") {
  describe.skip("codexc CLI workspace (Unix-only fixtures)", () => {
    it.skip("requires a dedicated Windows Workspace contract", () => undefined);
  });
} else {
  registerCodexcCliTests("workspace");
}
