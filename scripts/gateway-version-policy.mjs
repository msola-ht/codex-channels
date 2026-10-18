/** Gateway release suffixes do not change the required Codex base version. */
export function isGatewayVersionCompatible(gatewayVersion, codexVersion) {
  return gatewayVersion === codexVersion
    || new RegExp(
      `^${escapeRegExp(codexVersion)}-(?:fix[1-9]\\d*|rc\\.[1-9]\\d*)$`,
      "u",
    ).test(gatewayVersion);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
