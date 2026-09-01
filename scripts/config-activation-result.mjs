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
      return result("reload", "gateway", ["codexc service reload gateway"]);
    case "restart-gateway":
      return result("restart", "gateway", ["codexc service restart gateway"]);
    case "restart-webui":
      return result("restart", "webui", ["codexc service restart webui"]);
    case "restart-center":
      return result("restart", "center", ["codexc service restart center"]);
    case "restart-gateway-webui":
      return result("restart", "gateway+webui", [
        "codexc service restart gateway",
        "codexc service restart webui",
      ]);
    case "restart-app-server":
      return result("restart", "app-server", ["codexc service restart app-server"]);
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
