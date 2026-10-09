import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexHomePath } from "./codex-home.mjs";
import { parse } from "smol-toml";
import { readCodexConfigFileSync, readPrivateFileSync, writeCodexConfigFileAtomic, writePrivateFileAtomic } from "./private-file.mjs";

const maximumConfigBytes = 1_048_576;

// Keep the established Unix main-config contract; Windows uses the ACL adapter.
export function readCodexConfigFile(path, maximumBytes = maximumConfigBytes) {
  if (process.platform === "win32") return readCodexConfigFileSync(path, maximumBytes);
  const descriptor = openSync(realpathSync(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumBytes
      || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
      throw new Error("Codex 配置文件权限、类型或大小无效");
    }
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}

function canonicalPath(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Bind ownership once to the selected home, never infer it from a basename. */
export function createProviderFileAccess(environment) {
  if (environment === undefined) throw new Error("Provider 文件访问必须指定运行环境");
  const mainConfig = canonicalPath(join(codexHomePath(environment), "config.toml"));
  const isMainConfig = path => canonicalPath(path) === mainConfig;
  return {
    read: (path, maximumBytes) => (isMainConfig(path) ? readCodexConfigFile : readPrivateFileSync)(path, maximumBytes),
    write: (path, content) => {
      if (!isMainConfig(path)) return writePrivateFileAtomic(path, content);
      assertCodexConfigHasNoBearerTokens(content);
      return writeCodexConfigFileAtomic(path, content);
    },
  };
}

/** Backups stay private; their old token must never be published into the shared main config. */
function assertCodexConfigHasNoBearerTokens(content) {
  let document;
  try { document = parse(typeof content === "string" ? content : Buffer.from(content).toString("utf8")); }
  catch { throw new Error("Codex 主配置无法安全解析，未执行写入"); }
  const providers = document.model_providers;
  if (providers !== null && typeof providers === "object"
    && Object.values(providers).some(provider => provider !== null && typeof provider === "object" && provider.experimental_bearer_token !== undefined)) {
    throw new Error("Codex 主配置不得写入明文 Provider 凭据；旧备份已保留，请显式重新配置 Provider 使用私有凭据引用");
  }
}

export function createProviderFileReader(environment) {
  return createProviderFileAccess(environment).read;
}
