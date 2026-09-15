import { registerCodexcCliTests } from "./codexc-cli-suite.js";
import { describe, it } from "vitest";

if (process.platform === "win32") {
  describe.skip("codexc CLI doctor (Unix-only fixtures)", () => {
    it.skip("requires a dedicated Windows Doctor contract", () => undefined);
  });
} else {
  registerCodexcCliTests("doctor");
}
