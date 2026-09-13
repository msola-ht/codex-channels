import { protocolVersion } from "../codex-protocol/index.js";

/** 官方 `codex --remote` TUI 声明的客户端名；Gateway 默认以同一身份连接 App Server。 */
export const codexTuiClientName = "codex-tui";
export const supportedCodexCliVersion = protocolVersion.codexCli;
/** 当前锁定的 Codex CLI 版本；对外的客户端身份版本与展示版本共用该值。 */
export const codexCliVersion = supportedCodexCliVersion.replace(
  /^codex-cli\s+/,
  "",
);
