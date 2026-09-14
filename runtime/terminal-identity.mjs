import { terminalIdentityPattern } from "./gateway-config.mjs";

const dumbTerminalToken = "dumb";

/**
 * 按当前锁定 Codex CLI 的终端探测顺序推导模型上游 User-Agent 使用的终端标识：
 * `TERM_PROGRAM[/版本]` 优先，其次各终端专有变量，最后回退到 `TERM`。只读环境变量，不执行
 * 任何子进程；无法识别终端时返回 null。探测顺序与取值见 docs/user-agent-customization.md。
 */
export function detectTerminalUserAgentToken(environment = process.env) {
  const term = presentValue(environment.TERM);
  const termProgram = presentValue(environment.TERM_PROGRAM);
  if (termProgram !== null && termProgram.toLowerCase() !== "tmux") {
    const version = presentValue(environment.TERM_PROGRAM_VERSION);
    return sanitizeTerminalToken(version === null ? termProgram : `${termProgram}/${version}`);
  }
  if (presentValue(environment.GHOSTTY_RESOURCES_DIR) !== null) {
    return terminalNameToken("Ghostty", null);
  }
  if (hasAnyVariable(environment, ["WEZTERM_VERSION"])) {
    return terminalNameToken("WezTerm", presentValue(environment.WEZTERM_VERSION));
  }
  if (hasAnyVariable(environment, ["ITERM_SESSION_ID", "ITERM_PROFILE", "ITERM_PROFILE_NAME"])) {
    return terminalNameToken("iTerm.app", null);
  }
  if (hasAnyVariable(environment, ["TERM_SESSION_ID"])) {
    return terminalNameToken("Apple_Terminal", null);
  }
  if (
    hasAnyVariable(environment, ["KITTY_WINDOW_ID"])
    || (term !== null && term.includes("kitty"))
  ) {
    return terminalNameToken("kitty", null);
  }
  if (hasAnyVariable(environment, ["ALACRITTY_SOCKET"]) || term === "alacritty") {
    return terminalNameToken("Alacritty", null);
  }
  if (hasAnyVariable(environment, ["KONSOLE_VERSION"])) {
    return terminalNameToken("Konsole", presentValue(environment.KONSOLE_VERSION));
  }
  if (hasAnyVariable(environment, ["GNOME_TERMINAL_SCREEN"])) {
    return terminalNameToken("gnome-terminal", null);
  }
  if (hasAnyVariable(environment, ["VTE_VERSION"])) {
    return terminalNameToken("VTE", presentValue(environment.VTE_VERSION));
  }
  if (hasAnyVariable(environment, ["WT_SESSION"])) {
    return terminalNameToken("WindowsTerminal", null);
  }
  return term === null ? null : sanitizeTerminalToken(term);
}

/**
 * 可作为 `[codex].terminal_identity` 记录的终端标识：探测不到终端、只探测到 `dumb`，或结果超出
 * 配置字符集时返回 null，调用方不得据此写入猜测值。
 */
export function detectTerminalIdentity(environment = process.env) {
  const token = detectTerminalUserAgentToken(environment);
  if (token === null || token === dumbTerminalToken) return null;
  return terminalIdentityPattern.test(token) ? token : null;
}

function presentValue(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** 上游对多数终端专有变量按“已设置”判定，空值同样命中。 */
function hasAnyVariable(environment, names) {
  return names.some((name) => environment[name] !== undefined);
}

function terminalNameToken(name, version) {
  return sanitizeTerminalToken(version === null ? name : `${name}/${version}`);
}

function sanitizeTerminalToken(value) {
  return value.replace(/[^A-Za-z0-9._/-]/gu, "_");
}
