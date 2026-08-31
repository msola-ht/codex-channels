import { registerCodexcCliTests } from "./codexc-cli-suite.js";
import { describe, it } from "vitest";

if (process.platform === "win32") {
  describe.skip("codexc CLI workspace (Unix permission/process fixtures)", () => {
    it.skip("covered by Windows workspace contract checks", () => undefined);
  });
} else {
  registerCodexcCliTests("workspace");
}
