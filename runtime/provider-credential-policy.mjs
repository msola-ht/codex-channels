import { randomBytes } from "node:crypto";

/** Keep model authentication in the host, but blank its launch-only name in shell tools. */
export function isolateProviderCredential(provider, argumentsList, environment, credential) {
  const childEnvironment = { ...environment };
  if (credential === undefined) return { arguments: [...argumentsList], childEnvironment };
  if (typeof provider !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(provider)
    || typeof credential.environmentKey !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credential.environmentKey)
    || typeof credential.apiKey !== "string" || credential.apiKey.trim() === ""
    || credential.apiKey.length > 4096 || /\p{Cc}/u.test(credential.apiKey)) {
    throw new Error("App Server Provider 凭据隔离材料无效");
  }
  for (const key of Object.keys(childEnvironment)) {
    if (key === credential.environmentKey
      || process.platform === "win32" && key.toLowerCase() === credential.environmentKey.toLowerCase()) {
      delete childEnvironment[key];
    }
  }
  // A per-launch name avoids colliding with user-configured set entries, including
  // Windows case variants. Do not edit filters: their overlay replaces legacy rules.
  const environmentKey = `CODEX_CONNECT_MODEL_AUTH_${randomBytes(16).toString("hex").toUpperCase()}_API_KEY`;
  childEnvironment[environmentKey] = credential.apiKey;
  return {
    arguments: [
      ...argumentsList,
      "-c", `model_providers.${provider}.env_key=${JSON.stringify(environmentKey)}`,
      "-c", `shell_environment_policy.set.${environmentKey}=""`,
    ],
    childEnvironment,
  };
}
