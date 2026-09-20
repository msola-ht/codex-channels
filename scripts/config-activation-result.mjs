/**
 * Convert the internal activation scope returned by configuration writers into
 * one stable, presentation-neutral result.  Menus and automation can use this
 * object without interpreting legacy strings or composing service commands.
 */
export function configActivationResult(activation) {
  switch (activation) {
    case "none":
      return result("none", "none", []);
    case "reload":
      return result("reload", "gateway", ["codexc service reload"]);
    case "next-thread":
      return result("next-thread", "codex", []);
    case "next-tui":
      return result("next-tui", "codex", []);
    case "next-thread-and-tui":
      return result("next-thread-and-tui", "codex", []);
    case "restart-gateway":
      return result("restart", "gateway", ["codexc service restart gateway"]);
    case "restart-webui":
      return result("restart", "webui", ["codexc service restart webui"]);
    case "restart-app-server":
      return result("restart", "app-server", ["codexc service restart app-server"]);
    case "restart-app-server-webui":
      return result("restart", "app-server-webui", [
        "codexc service restart app-server",
        "codexc service restart webui",
      ]);
    case "restart-all":
      return result("restart", "all", ["codexc service restart all"]);
    case "reinstall-services":
      return result("reinstall-required", "services", ["codexc service install"]);
    default:
      return result("failed", "unknown", []);
  }
}

function result(status, target, commands) {
  return Object.freeze({ status, target, commands: Object.freeze(commands) });
}
