import { registerCodexcCliTests } from "./codexc-cli-suite.js";
import { describe, it } from "vitest";

if (process.platform === "win32") {
  describe.skip("codexc CLI doctor (Unix socket/process fixtures)", () => {
    it.skip("covered by Windows service contract checks", () => undefined);
  });
} else {
  registerCodexcCliTests("doctor");
}
