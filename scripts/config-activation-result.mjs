/**
 * Convert the internal activation scope returned by configuration writers into
 * one stable, presentation-neutral result.  Menus and automation can use this
 * object without parsing presentation text or composing service commands.
 */
export function configActivationResult(activation) {
  switch (activation) {
    case "none":
      return result("none", "none", []);
    case "reload":
      return result("reload", "gateway", ["codexc reload"]);
    case "next-thread":
      return result("next-thread", "codex", []);
    case "next-tui":
      return result("next-tui", "codex", []);
    case "next-thread-and-tui":
      return result("next-thread-and-tui", "codex", []);
    case "restart-gateway":
      return result("restart", "gateway", ["codexc restart gateway"]);
    case "restart-webui":
      return result("restart", "webui", ["codexc restart webui"]);
    case "restart-app-server":
      return result("restart", "app-server", ["codexc restart appserver"]);
    case "restart-app-server-gateway-webui":
      return result("restart", "app-server-gateway-webui", [
        "codexc stop gateway",
        "codexc restart appserver",
        "codexc start gateway",
        "codexc restart webui",
      ]);
    case "restart-all":
      return result("restart", "all", ["codexc restart all"]);
    case "reinstall-services":
      return result("reinstall-required", "services", ["codexc install"]);
    default:
      return result("failed", "unknown", []);
  }
}

function result(status, target, commands) {
  return Object.freeze({ status, target, commands: Object.freeze(commands) });
}
