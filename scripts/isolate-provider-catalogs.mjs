import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "smol-toml";
import { connectHomePath, providerStorageRoot } from "../runtime/connect-home.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { managedProviderAccountFamilies, loadManagedModelProviderDefinitions, isManagedProviderApiKeyValid } from "../runtime/model-provider-definitions.mjs";
import { loadCustomSwitchingProviderIds, customSwitchingProviderRegistryPath } from "../runtime/model-provider-runtime.mjs";
import { parseResponsesModelCatalog, responsesContextSyncPath, responsesProviderBackupPath } from "../runtime/model-provider-responses-catalog.mjs";
import { providerCatalogIsolationPath } from "../runtime/provider-catalog-isolation.mjs";
import { assertPrivateDirectoryAccessSync, readPrivateFileSync, writePrivateFileAtomic } from "../runtime/private-file.mjs";
import { createProviderFileAccess } from "../runtime/provider-file-access.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { applyProviderFileUpdates } from "./managed-provider-files.mjs";
import { managedAccountPrimarySocket } from "./managed-provider-account-runtime.mjs";
import { inspectAppServerSupervisorState } from "../runtime/app-server-supervisor.mjs";
import { decodeProviderCredentialDocument, maximumProviderCredentialBytes, providerCredentialMatchesIdentity } from "../runtime/provider-credential-document.mjs";
import { managedPrimaryCredentialPath } from "../runtime/managed-provider-credentials.mjs";
import { customPrimaryProviderCredentialEnvironmentKey, customPrimaryProviderCredentialPath } from "../runtime/model-provider-custom-runtime.mjs";

const maximumBytes = 16 * 1024 * 1024;
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = content => content === null ? null : createHash("sha256").update(content).digest("hex");
const customId = /^cp-[A-Za-z0-9_-]{1,61}$/u;
const archiveId = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const journalLayout = "family-models-family-account-materials-v1";

function parseConfig(content) {
  try { return parse(content); } catch { throw new Error("Provider 配置无法安全解析，未执行模型目录合并"); }
}

function directoryNames(path) {
  let metadata;
  try { metadata = lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || process.platform !== "win32" && ((metadata.mode & 0o077) !== 0 || process.getuid !== undefined && metadata.uid !== process.getuid())) {
    throw new Error(`迁移目录类型、所有者或权限无效：${path}`);
  }
  assertPrivateDirectoryAccessSync(path);
  return readdirSync(path).sort();
}

function backupFiles(directory, definition) {
  const fixed = ["config.json", "config.toml", "managed.toml", definition.profileFileName];
  const archive = new RegExp(`^(?:config-${archiveId}\\.(?:json|toml)|config\\.json\\.${archiveId})$`, "u");
  return directoryNames(directory).map(name => {
    if (!fixed.includes(name) && !archive.test(name)) throw new Error(`账户备份含未知文件：${directory}`);
    return join(directory, name);
  });
}

function credentialFiles(directory) {
  return directoryNames(directory).map(name => {
    if (!/^[a-f0-9]{32}\.json$/u.test(name)) throw new Error(`Provider 凭据目录含未知文件：${directory}`);
    return join(directory, name);
  });
}

// Include both ends even before copying, so a partial write has the same journal scope.
function pairedFiles(directories, readFiles) {
  const names = new Set(directories.flatMap(directory => readFiles(directory).map(path => path.slice(directory.length + 1))));
  return [...names].sort().map(name => ({ sources: directories.map(directory => join(directory, name)), target: join(directories.at(-1), name) }));
}

function snapshotProviderFiles(paths, environment) {
  const access = createProviderFileAccess(environment);
  return [...new Set(paths)].map(path => {
    const readCurrent = () => {
      try { return Buffer.from(access.read(path, maximumBytes)); }
      catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
    };
    return { path, content: readCurrent(), readCurrent, writeCurrent: content => {
      if (content !== undefined) return access.write(path, content);
      try { unlinkSync(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    } };
  });
}

function materials(environment) {
  const root = providerStorageRoot(environment), home = codexHomePath(environment);
  const config = join(home, "config.toml");
  directoryNames(root);
  const definitions = loadManagedModelProviderDefinitions(environment).filter(definition => definition.accountId !== undefined);
  const accounts = definitions.map(definition => {
    const family = definition.storageId ?? definition.id;
    const directory = join(root, family, definition.id), flatDirectory = join(root, definition.id);
    const legacyDirectory = join(root, family, "accounts", definition.accountId);
    const directories = [legacyDirectory, flatDirectory, directory];
    for (const parent of directories) directoryNames(parent);
    const targetDirectory = join(root, family);
    directoryNames(targetDirectory);
    const names = [definition.catalogFileName, definition.catalogManifestFileName,
      `${definition.catalogFileName}.backup`, `${definition.catalogManifestFileName}.backup`, `${definition.catalogFileName}.settings-backup`];
    const source = join(flatDirectory, definition.catalogFileName), target = join(targetDirectory, definition.catalogFileName);
    const backups = pairedFiles(directories.map(parent => join(parent, definition.backupDirectoryName)), parent => backupFiles(parent, definition));
    const credentials = pairedFiles([join(root, family, "primary-credentials", definition.id),
      ...directories.map(parent => join(parent, "primary-credentials"))], credentialFiles);
    return { provider: definition.id, definition, family, directory, directories, targetDirectory, names, source, target,
      sources: [...directories, targetDirectory].map(parent => join(parent, definition.catalogFileName)),
      marker: join(directory, definition.managedMarkerFileName), profile: join(home, definition.profileFileName),
      markers: directories.map(parent => join(parent, definition.managedMarkerFileName)), backups, credentials,
      paths: [...directories, targetDirectory].flatMap(parent => names.map(name => join(parent, name))),
      pending: [...directories, targetDirectory].flatMap(parent => [".pending", ".settings-pending"].map(suffix => join(parent, `${definition.catalogFileName}${suffix}`))) };
  });
  let homeNames;
  try { homeNames = readdirSync(home); } catch (error) { if (error?.code !== "ENOENT") throw error; homeNames = []; }
  const profiles = new Set([config, ...accounts.map(account => account.profile),
    ...homeNames.filter(name => /^sf-[A-Za-z0-9_-]+\.config\.toml$/u.test(name)).map(name => join(home, name))]);
  const customIds = new Set(loadCustomSwitchingProviderIds(environment).filter(id => customId.test(id)));
  for (const name of directoryNames(root)) if (customId.test(name)) customIds.add(name);
  for (const parent of [join(root, "responses"), join(root, "custom")]) {
    for (const name of directoryNames(parent)) if (customId.test(name)) customIds.add(name);
  }
  for (const path of profiles) {
    if (!existsSync(path)) continue;
    for (const { provider } of selections(parseConfig(createProviderFileAccess(environment).read(path, maximumBytes)))) {
      if (customId.test(provider)) customIds.add(provider);
    }
  }
  for (const name of directoryNames(join(connectHomePath(environment), "private", "responses-providers"))) {
    if (/^cp-[A-Za-z0-9_-]{1,61}\.json$/u.test(name)) customIds.add(name.slice(0, -5));
  }
  for (const provider of [...customIds].sort()) {
    const directory = join(root, provider);
    const legacyDirectory = join(root, "responses", provider), directories = [legacyDirectory, directory];
    for (const parent of directories) directoryNames(parent);
    const profile = join(home, `sf-${provider}.config.toml`);
    profiles.add(profile);
    const credentials = pairedFiles([join(root, "custom", provider, "primary-credentials"), join(directory, "primary-credentials")], credentialFiles);
    accounts.push({ provider, custom: true, directory, directories, profile,
      source: join(legacyDirectory, "models.json"), target: join(directory, "models.json"),
      sources: directories.map(parent => join(parent, "models.json")),
      recoveryBackup: responsesProviderBackupPath(environment, provider),
      names: ["models.json", "models.json.backup", "provider.json"],
      paths: directories.flatMap(parent => ["models.json", "models.json.backup", "provider.json"].map(name => join(parent, name))), backups: [], credentials,
      pending: directories.flatMap(parent => [".pending", ".settings-pending"].map(suffix => join(parent, `models.json${suffix}`))) });
  }
  for (const account of accounts) for (const pending of account.pending) {
    if (existsSync(pending)) throw new Error(`Provider ${account.provider} 有未完成模型事务，请先在原版本恢复`);
  }
  const registryPaths = [customSwitchingProviderRegistryPath(environment), ...managedProviderAccountFamilies.map(family => family.accountsFilePath(environment))];
  const paths = [...new Set([...profiles, ...registryPaths,
    ...accounts.flatMap(account => [...account.paths, ...account.backups.flatMap(file => file.sources), ...account.credentials.flatMap(file => file.sources),
      ...(account.markers ?? []), ...(account.recoveryBackup ? [account.recoveryBackup] : [])])])];
  const writable = new Set([...profiles, ...accounts.flatMap(account => [...account.backups.map(file => file.target), ...account.credentials.map(file => file.target),
    ...(account.custom ? [account.recoveryBackup, ...account.names.map(name => join(account.directory, name))]
      : [account.marker, ...account.names.map(name => join(account.targetDirectory, name))])])]);
  return { accounts, config, profiles: [...profiles], registryPaths, paths, writable };
}

function selections(document) {
  const result = [{ document, provider: document?.model_provider, catalog: document?.model_catalog_json, model: document?.model }];
  if (document?.profiles && typeof document.profiles === "object") {
    for (const profile of Object.values(document.profiles)) {
      if (profile && typeof profile === "object") result.push({ document: profile, provider: profile.model_provider ?? document.model_provider,
        catalog: profile.model_catalog_json ?? document.model_catalog_json, model: profile.model ?? document.model });
    }
  }
  return result;
}

function rewriteSelection(document, layout) {
  for (const selection of selections(document)) {
    const account = layout.accounts.find(account => account.provider === selection.provider);
    if (!account) continue;
    const sources = account.custom ? account.sources : layout.accounts.filter(sibling => sibling.family === account.family).flatMap(sibling => sibling.sources);
    if (sources.includes(selection.catalog)) selection.document.model_catalog_json = account.target;
  }
  return document;
}

function rewriteConfig(content, layout) {
  const document = parseConfig(content), previous = JSON.stringify(document);
  rewriteSelection(document, layout);
  return previous === JSON.stringify(document) ? content : stringify(document);
}

function parseJson(content, label) {
  try { return JSON.parse(content); } catch { throw new Error(`${label}无法安全解析`); }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function equalJson(left, right, label) {
  return JSON.stringify(canonical(parseJson(left, label))) === JSON.stringify(canonical(parseJson(right, label)));
}

function rewriteInstallationBackup(content, path, layout) {
  if (path.endsWith("managed.toml")) return content;
  if (path.endsWith(".toml")) return rewriteConfig(content, layout);
  const backup = parseJson(content, "账户安装备份");
  if (!backup?.config || typeof backup.config !== "object" || Array.isArray(backup.config)) throw new Error("账户安装备份结构无效");
  const previous = JSON.stringify(backup);
  rewriteSelection(backup.config, layout);
  return previous === JSON.stringify(backup) ? content : encode(backup);
}

function rewriteSettingsBackup(content, sourceDirectory, account, layout) {
  const backup = parseJson(content, `家族 ${account.family} 模型设置备份`);
  const filePaths = new Map(account.names.filter(name => !name.endsWith(".settings-backup"))
    .map(name => [join(sourceDirectory, name), join(account.targetDirectory, name)]));
  const siblings = layout.accounts.filter(sibling => sibling.family === account.family);
  const markerPaths = new Map(siblings.flatMap(sibling => sibling.markers.map(marker => [marker, sibling.marker])));
  for (const sibling of siblings) filePaths.set(sibling.profile, sibling.profile);
  const guardPaths = new Set([layout.config,
    ...managedProviderAccountFamilies.filter(family => (family.definition.storageId ?? family.definition.id) === account.family)
      .map(family => family.accountsFilePath(layout.environment)),
    ...siblings.flatMap(sibling => [...sibling.markers, sibling.profile]),
    ...account.names.filter(name => name === account.definition.catalogManifestFileName || name.endsWith(".backup"))
      .map(name => join(sourceDirectory, name))]);
  if (![1, 2].includes(backup?.schemaVersion)
    || Object.keys(backup).some(key => !(backup.schemaVersion === 2 ? ["schemaVersion", "files", "guards"] : ["schemaVersion", "files"]).includes(key))
    || !Array.isArray(backup.files) || backup.files.length < 1
    || backup.files.length > filePaths.size || new Set(backup.files.map(file => file?.path)).size !== backup.files.length
    || !backup.files.some(file => file?.path === join(sourceDirectory, account.definition.catalogFileName))
    || backup.files.some(file => !filePaths.has(file?.path) || Object.keys(file).some(key => !["path", "previous", "next"].includes(key))
      || typeof file.next !== "string" || !(typeof file.previous === "string" || file.previous === null && file.path.endsWith(".backup")))
    || backup.schemaVersion === 2 && (!Array.isArray(backup.guards) || new Set(backup.guards.map(file => file?.path)).size !== backup.guards.length
      || backup.guards.some(file => !guardPaths.has(file?.path) || Object.keys(file).some(key => !["path", "content"].includes(key))
        || backup.files.some(update => update.path === file.path) || file.content !== null && typeof file.content !== "string"))) {
    throw new Error(`家族 ${account.family} 模型设置备份路径或结构无效`);
  }
  if (backup.schemaVersion === 2) {
    const required = [join(sourceDirectory, account.definition.catalogManifestFileName),
      ...managedProviderAccountFamilies.filter(family => (family.definition.storageId ?? family.definition.id) === account.family)
        .map(family => family.accountsFilePath(layout.environment)),
      ...siblings.map(sibling => sibling.mode === "exclusive" ? layout.config : sibling.profile)];
    if (required.some(path => !backup.files.some(file => file.path === path) && !backup.guards.some(file => file.path === path))) {
      throw new Error(`家族 ${account.family} 模型设置备份缺少完整账户守卫快照`);
    }
    if (siblings.some(sibling => !backup.guards.some(file => sibling.markers.includes(file.path)))) throw new Error(`家族 ${account.family} 模型设置备份缺少账户管理标记守卫`);
  }
  for (const file of backup.files) {
    if (siblings.some(sibling => sibling.profile === file.path)) {
      for (const field of ["previous", "next"]) if (file[field] !== null) file[field] = rewriteConfig(file[field], layout);
    }
    file.path = filePaths.get(file.path);
  }
  for (const guard of backup.guards ?? []) {
    if (guard.content !== null && (guard.path === layout.config || siblings.some(sibling => sibling.profile === guard.path))) guard.content = rewriteConfig(guard.content, layout);
    guard.path = filePaths.get(guard.path) ?? markerPaths.get(guard.path) ?? guard.path;
  }
  if (new Set((backup.guards ?? []).map(file => file.path)).size !== (backup.guards ?? []).length) throw new Error(`家族 ${account.family} 模型设置备份目标守卫重复`);
  return encode(backup);
}

function rewriteRecoveryBackup(content, account, layout, environment) {
  const backup = parseJson(content, `Provider ${account.provider} 配置恢复备份`);
  const allowed = new Set([layout.config, account.profile, customSwitchingProviderRegistryPath(environment), ...account.directories.map(directory => join(directory, "provider.json"))]);
  if (backup?.schemaVersion !== 1 || !Array.isArray(backup.files) || backup.files.length < 1 || backup.files.length > 4
    || new Set(backup.files.map(file => file?.path)).size !== backup.files.length
    || Object.keys(backup).some(key => !["schemaVersion", "files"].includes(key))
    || backup.files.some(file => !allowed.has(file?.path) || Object.keys(file).some(key => !["path", "content"].includes(key))
      || file.content !== null && typeof file.content !== "string")) throw new Error(`Provider ${account.provider} 配置恢复备份路径或结构无效`);
  const previous = JSON.stringify(backup);
  for (const file of backup.files) {
    if (file.content !== null && [layout.config, account.profile].includes(file.path)) file.content = rewriteConfig(file.content, layout);
    if (account.directories.some(directory => file.path === join(directory, "provider.json"))) file.path = join(account.directory, "provider.json");
  }
  if (new Set(backup.files.map(file => file.path)).size !== backup.files.length) throw new Error(`Provider ${account.provider} 配置恢复备份目标重复`);
  return previous === JSON.stringify(backup) ? content : encode(backup);
}

function validateCredential(content, account) {
  let credential;
  try { credential = Buffer.byteLength(content) <= maximumProviderCredentialBytes ? decodeProviderCredentialDocument(content) : undefined; } catch { /* Do not expose credential content. */ }
  let origin;
  try { origin = new URL(credential?.origin).origin; } catch { /* Rejected below. */ }
  if (credential === undefined || origin === undefined || origin === "null" || credential.origin !== origin
    || !providerCredentialMatchesIdentity(credential, account.provider, account.custom ? origin : new URL(account.definition.baseUrl).origin)
    || (account.custom ? typeof credential.apiKey !== "string" || credential.apiKey.trim() === "" || credential.apiKey.length > 4096 || /\p{Cc}/u.test(credential.apiKey)
      : !isManagedProviderApiKeyValid(account.definition, credential.apiKey))) throw new Error(`Provider ${account.provider} 私有凭据格式或身份绑定无效`);
}

function buildPlan(environment, layout) {
  const snapshots = snapshotProviderFiles(layout.paths, environment);
  const original = path => snapshots.find(snapshot => snapshot.path === path)?.content?.toString("utf8");
  const updates = new Map(), families = [], providers = new Set(), retainedSourceBackups = [];
  layout.environment = environment;
  const copy = (file, account, transform = content => content) => {
    const available = file.sources.flatMap(path => {
      const content = original(path);
      return content === undefined ? [] : [{ path, content: transform(content, path) }];
    });
    if (available.length === 0) return;
    if (available.some(source => source.content !== available[0].content)) throw new Error(`Provider ${account.provider} 迁移来源与目标冲突：${file.target}`);
    if (original(file.target) !== available[0].content) { updates.set(file.target, available[0].content); providers.add(account.provider); }
  };
  const documents = layout.profiles.flatMap(path => {
    const content = original(path);
    return content === undefined ? [] : selections(parseConfig(content)).map(selection => ({ ...selection, path }));
  });
  for (const selection of documents) {
    if (managedProviderAccountFamilies.some(family => family.matches(selection.provider))
      && !layout.accounts.some(account => account.provider === selection.provider)) throw new Error(`Profile 引用了未登记受管账户 ${selection.provider}，拒绝遗漏其模型目录`);
  }
  const references = new Map();
  for (const account of layout.accounts) {
    const selected = documents.filter(selection => selection.provider === account.provider);
    references.set(account.provider, selected);
    for (const { document } of documents) {
      const block = document.model_providers?.[account.provider], environmentKey = block?.env_key;
      if (environmentKey === undefined) continue;
      if (typeof environmentKey !== "string") throw new Error(`Provider ${account.provider} 凭据引用无效`);
      const customPrefix = account.custom ? customPrimaryProviderCredentialEnvironmentKey(account.provider, "0".repeat(32)).replace(`${"0".repeat(32)}_API_KEY`, "") : undefined;
      if (account.custom && !environmentKey.startsWith(customPrefix)) continue;
      const target = account.custom ? customPrimaryProviderCredentialPath(environment, account.provider, environmentKey)
        : managedPrimaryCredentialPath(environment, account.definition, environmentKey);
      const credential = account.credentials.find(file => file.target === target);
      if (!credential || !credential.sources.some(path => original(path) !== undefined)) throw new Error(`Provider ${account.provider} 引用的固定私有凭据缺失`);
      if (account.custom) {
        let origin;
        try { origin = new URL(block.base_url).origin; } catch { throw new Error(`Provider ${account.provider} 固定私有凭据上游无效`); }
        for (const path of credential.sources) {
          const content = original(path);
          if (content === undefined) continue;
          validateCredential(content, account);
          if (!providerCredentialMatchesIdentity(decodeProviderCredentialDocument(content), account.provider, origin)) throw new Error(`Provider ${account.provider} 固定私有凭据与上游 Origin 不匹配`);
        }
      }
    }
    if (!account.custom) {
      const ownerSelections = selected.filter(selection => [layout.config, account.profile].includes(selection.path));
      const referencedDirectories = account.directories.filter(directory => ownerSelections.some(selection => selection.catalog === join(directory, account.definition.catalogFileName)));
      if (referencedDirectories.length > 1) throw new Error(`账户 ${account.provider} 同时引用不同账户布局，拒绝猜测管理材料来源`);
      account.activeDirectory = referencedDirectories[0]
        ?? [...account.directories].reverse().find(directory => original(join(directory, account.definition.managedMarkerFileName)) !== undefined);
      if (account.activeDirectory === undefined) throw new Error(`账户 ${account.provider} 缺少管理标记`);
      const activeMarker = join(account.activeDirectory, account.definition.managedMarkerFileName);
      const markerText = original(activeMarker);
      if (markerText === undefined) throw new Error(`账户 ${account.provider} 缺少管理标记`);
      const marker = parseConfig(markerText);
      if (marker.version !== 1 || marker.provider !== account.provider || ![undefined, "switching", "exclusive"].includes(marker.mode)) throw new Error(`账户 ${account.provider} 管理标记无效`);
      account.mode = marker.mode;
      const ownerPath = marker.mode === "exclusive" ? layout.config : account.profile;
      if (original(ownerPath) === undefined || parseConfig(original(ownerPath)).model_provider !== account.provider) throw new Error(`账户 ${account.provider} 配置归属不一致`);
      const allowed = new Set(layout.accounts.filter(sibling => sibling.family === account.family).flatMap(sibling => sibling.sources));
      if (selected.some(selection => !allowed.has(selection.catalog))) throw new Error(`账户 ${account.provider} 引用了非预期模型目录`);
      copy({ sources: account.markers, target: account.marker }, account);
    } else {
      if (selected.some(selection => !account.sources.includes(selection.catalog))) throw new Error(`Provider ${account.provider} 引用了非预期模型目录`);
      const sources = [...new Set(selected.map(selection => selection.catalog))];
      if (sources.length === 0 && original(account.source) !== undefined) throw new Error(`Provider ${account.provider} 旧模型目录没有实际配置引用，拒绝猜测来源`);
      const sourcePath = sources[0] ?? account.target, source = original(sourcePath);
      if (sources.some(path => original(path) !== source)) throw new Error(`Provider ${account.provider} 实际引用模型目录存在冲突`);
      if (selected.length > 0 && source === undefined) throw new Error(`Provider ${account.provider} 模型目录缺失`);
      if (source !== undefined) {
        const catalog = parseResponsesModelCatalog(source);
        for (const selection of selected) if (catalog.models.filter(model => model.slug === selection.model).length !== 1) throw new Error(`Provider ${account.provider} 默认模型缺失或重复`);
        for (const name of account.names) {
          const from = join(dirname(sourcePath), name), target = join(account.directory, name);
          if (from !== target && original(from) === undefined && original(target) !== undefined) throw new Error(`Provider ${account.provider} 目标存在无对应来源的文件：${target}`);
          copy({ sources: [...new Set([from, target])], target }, account);
        }
      }
    }
  }
  const familyNames = [...new Set(layout.accounts.filter(account => !account.custom).map(account => account.family))];
  for (const family of familyNames) {
    const siblings = layout.accounts.filter(account => account.family === family), account = siblings[0];
    const selected = siblings.flatMap(sibling => references.get(sibling.provider));
    const sources = [...new Set(selected.map(selection => selection.catalog))].sort();
    const catalogSources = sources.map(path => {
      const content = original(path);
      if (content === undefined) throw new Error(`家族 ${family} 当前引用的模型目录缺失：${path}`);
      const manifest = original(join(dirname(path), account.definition.catalogManifestFileName));
      if (manifest === undefined) throw new Error(`家族 ${family} 当前引用的模型来源文件缺失：${path}`);
      const catalog = parseJson(content, `家族 ${family} 模型目录`);
      if (!Array.isArray(catalog?.models)) throw new Error(`家族 ${family} 模型目录结构无效`);
      parseJson(manifest, `家族 ${family} 模型来源文件`);
      return { path, content, manifest, catalog };
    });
    const chosen = catalogSources[0];
    if (!chosen) throw new Error(`家族 ${family} 没有可确认的实际模型目录引用`);
    if (catalogSources.some(source => !equalJson(source.content, chosen.content, "模型目录") || !equalJson(source.manifest, chosen.manifest, "模型来源文件"))) {
      throw new Error(`家族 ${family} 实际引用的模型或 manifest 存在差异，拒绝猜测；请先明确统一各账户来源：${sources.join(", ")}`);
    }
    for (const selection of selected) if (chosen.catalog.models.filter(model => model.slug === selection.model).length !== 1) throw new Error(`家族 ${family} 当前选择模型缺失或重复`);
    const targets = new Map([[account.target, chosen.content], [join(account.targetDirectory, account.definition.catalogManifestFileName), chosen.manifest]]);
    for (const name of account.names.slice(2)) {
      const available = sources.flatMap(source => {
        const path = join(dirname(source), name), content = original(path);
        return content === undefined ? [] : [{ path, content: name.endsWith(".settings-backup")
          ? rewriteSettingsBackup(content, dirname(source), account, layout) : content }];
      });
      const target = join(account.targetDirectory, name);
      const different = available.some(file => !equalJson(file.content, available[0].content, `家族 ${family} 模型备份`));
      if (different && name.endsWith(".settings-backup")) throw new Error(`家族 ${family} 有多个不同的模型设置恢复备份，拒绝选择；请先核对并归档冲突备份：${available.map(file => file.path).join(", ")}`);
      if (different) retainedSourceBackups.push(...available.map(file => file.path));
      targets.set(target, different ? null : available[0]?.content ?? null);
    }
    const changes = [];
    for (const [path, next] of targets) {
      const previous = original(path) ?? null;
      if (previous === next) continue;
      updates.set(path, next);
      changes.push({ path, operation: next === null ? "remove-stale-backup" : previous === null ? "create" : "replace",
        previousBytes: previous === null ? 0 : Buffer.byteLength(previous), nextBytes: next === null ? 0 : Buffer.byteLength(next),
        previousSha256: digest(previous), nextSha256: digest(next) });
    }
    if (changes.length > 0 || sources.some(source => source !== account.target)) {
      families.push({ family, providers: siblings.map(sibling => sibling.provider), sources, target: account.target, changes });
      for (const sibling of siblings) providers.add(sibling.provider);
    }
  }
  for (const path of layout.profiles) {
    const content = original(path);
    if (content === undefined) continue;
    const next = rewriteConfig(content, layout);
    if (next !== content) updates.set(path, next);
  }
  for (const account of layout.accounts) {
    for (const file of account.backups) {
      copy(file, account, (content, path) => rewriteInstallationBackup(content, path, layout));
    }
    for (const file of account.credentials) copy(file, account, content => { validateCredential(content, account); return content; });
    const content = account.recoveryBackup && original(account.recoveryBackup);
    if (content !== undefined) {
      const next = rewriteRecoveryBackup(content, account, layout, environment);
      if (next !== content) { updates.set(account.recoveryBackup, next); providers.add(account.provider); }
    }
  }
  return { providers: [...providers], families, retainedSourceBackups: [...new Set(retainedSourceBackups)],
    references: layout.profiles.filter(path => updates.has(path)), changedFiles: updates.size,
    files: snapshots.map(snapshot => ({ path: snapshot.path, previous: snapshot.content?.toString("utf8") ?? null,
      next: updates.has(snapshot.path) ? updates.get(snapshot.path) : snapshot.content?.toString("utf8") ?? null })), order: [...updates.keys()] };
}

function readJournal(path, environment) {
  let journal;
  try { journal = JSON.parse(readPrivateFileSync(path, maximumBytes)); } catch { throw new Error("模型目录合并恢复记录无法安全读取"); }
  if (journal?.schemaVersion !== 4 || !Array.isArray(journal.files) || !Array.isArray(journal.order)
    || !Array.isArray(journal.providers) || !Array.isArray(journal.families) || !Array.isArray(journal.references)
    || !Array.isArray(journal.retainedSourceBackups)) throw new Error("模型目录合并恢复记录格式无效；旧版本未完成事务须先使用原版本恢复");
  if (journal.layout !== journalLayout) throw new Error("模型目录合并恢复记录布局不受支持");
  const layout = materials(environment);
  const scope = { paths: layout.paths, writable: layout.writable };
  const allowed = new Set(scope.paths), seen = new Set();
  for (const file of journal.files) {
    if (!file || !allowed.has(file.path) || seen.has(file.path)
      || (file.previous !== null && typeof file.previous !== "string") || (file.next !== null && typeof file.next !== "string")) throw new Error("模型目录合并恢复记录路径或内容无效");
    seen.add(file.path);
  }
  if (seen.size !== allowed.size || new Set(journal.order).size !== journal.order.length
    || journal.order.some(path => !seen.has(path))
    || journal.providers.some(provider => !layout.accounts.some(account => account.provider === provider))) throw new Error("账户清单与模型目录合并恢复记录不一致");
  if (journal.order.some(path => !scope.writable.has(path)) || journal.files.some(file => file.previous !== file.next && !journal.order.includes(file.path))) throw new Error("模型目录合并恢复记录包含非目标文件写入");
  return journal;
}

function journalSnapshots(journal, environment) {
  const snapshots = snapshotProviderFiles(journal.files.map(file => file.path), environment);
  for (const file of journal.files) {
    const current = snapshots.find(snapshot => snapshot.path === file.path)?.content?.toString("utf8") ?? null;
    if (current !== file.previous && current !== file.next) throw new Error("模型目录合并期间文件已修改；保留恢复记录，请先核对备份");
  }
  return snapshots;
}

async function applyJournal(journal, action, environment) {
  const snapshots = journalSnapshots(journal, environment);
  const order = action === "rollback" ? [...journal.order].reverse() : journal.order;
  const updates = new Map(order.flatMap(path => {
    const file = journal.files.find(entry => entry.path === path), content = action === "rollback" ? file.previous : file.next;
    const current = snapshots.find(snapshot => snapshot.path === path)?.content?.toString("utf8") ?? null;
    return current === content ? [] : [[path, content ?? undefined]];
  }));
  await applyProviderFileUpdates(updates, snapshots);
}

function summary(action, journal) {
  return { action, providers: journal.providers, families: journal.families, references: journal.references,
    retainedSourceBackups: journal.retainedSourceBackups, changedFiles: journal.changedFiles,
    changes: journal.order.map(path => {
      const file = journal.files.find(file => file.path === path);
      return { path, operation: file.next === null ? "remove-stale-backup" : file.previous === null ? "create" : "replace",
        previousSha256: digest(file.previous), nextSha256: digest(file.next) };
    }) };
}

export async function isolateProviderCatalogs(action = "preview", environment = process.env) {
  if (!["preview", "write", "resume", "rollback"].includes(action)) throw new Error("模型目录合并操作无效");
  return withModelProviderManagementTransaction(environment, async () => {
    if (existsSync(responsesContextSyncPath(environment))) throw new Error("旧上下文事务尚未恢复，请先使用 primary-provider recover 完成恢复");
    const path = providerCatalogIsolationPath(environment), backup = `${path}.v4.backup`;
    if (["preview", "write"].includes(action) && existsSync(path)) throw new Error("已有未完成目录事务，请使用对应版本的 --resume 或 --rollback");
    if (["resume", "rollback"].includes(action) && !existsSync(path) && !existsSync(backup) && existsSync(`${path}.v3.backup`)) {
      throw new Error("已有旧版 v3 目录备份，须使用对应原版本恢复；当前版本仅恢复 v4 事务");
    }
    const journal = ["resume", "rollback"].includes(action)
      ? readJournal(existsSync(path) ? path : backup, environment) : { schemaVersion: 4, layout: journalLayout, ...buildPlan(environment, materials(environment)) };
    if (action === "preview") return summary(action, journal);
    if (action === "write" && journal.order.length === 0) return summary("unchanged", journal);
    const supervisor = await inspectAppServerSupervisorState(managedAccountPrimarySocket(environment));
    if (supervisor.status !== "missing") throw new Error("App Server 仍在运行或监管状态无法确认；请先停止整个 App Server（包括聚合实例）再合并模型目录");
    const content = encode(journal);
    if (Buffer.byteLength(content) > maximumBytes) throw new Error("模型目录合并恢复记录超过大小限制");
    const previousBackup = existsSync(backup) ? readPrivateFileSync(backup, maximumBytes) : undefined;
    if (action === "write" && previousBackup !== undefined) throw new Error("已有模型目录合并 v4 备份，请先核对并另行归档，拒绝覆盖");
    if (previousBackup !== undefined && previousBackup !== content) throw new Error("模型目录合并 v4 备份与当前事务不一致，拒绝覆盖");
    if (existsSync(path) && readPrivateFileSync(path, maximumBytes) !== content) throw new Error("模型目录合并恢复记录已变化，拒绝覆盖");
    journalSnapshots(journal, environment);
    await writePrivateFileAtomic(path, content);
    await applyJournal(journal, action, environment);
    if ((existsSync(backup) ? readPrivateFileSync(backup, maximumBytes) : undefined) !== previousBackup) throw new Error("模型目录合并 v4 备份在恢复期间变化，保留事务记录");
    await writePrivateFileAtomic(backup, content);
    if (createProviderFileAccess(environment).read(path, maximumBytes) !== content) throw new Error("目录恢复记录在操作期间发生变化，未清除记录");
    unlinkSync(path);
    return summary(action, journal);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) console.log("用法：node scripts/isolate-provider-catalogs.mjs [--write|--resume|--rollback]\n默认预览；写入前须停止 App Server。按当前配置实际引用，将 nested 或 flat 受管账户模型合并到 providers/deepseek|clp|ccg|opencode-go/；账户标记、安装备份和固定凭据复制到对应家族下的完整 Provider ID 目录。旧 CP 模型、上游元数据和固定凭据复制到 providers/cp-ID/。同步全部 Profile 及安装/恢复备份引用。来源、账户目标或 CP 目标冲突拒绝猜测；陈旧家族模型目标仅显式 --write 并以私有 v4 journal 完整备份后替换。保留全部旧源和 v3 备份，不自动重启服务。旧未完成事务须先使用原版本恢复，当前版本仅恢复 v4 事务。");
  else if (args.length > 1 || (args.length === 1 && !["--write", "--resume", "--rollback"].includes(args[0]))) {
    console.error("不支持的参数；使用 --help 查看用法"); process.exitCode = 1;
  } else isolateProviderCatalogs(args[0]?.slice(2) ?? "preview").then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
