import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageFiles = new Set([
  "package.json", "package-lock.json", ".npmignore", "install.sh", "install.ps1",
  "tsconfig.json", "tsconfig.build.json", "provider-model-catalog.json", "startup-network-policy.json",
  "scripts/prepare-package.mjs", "scripts/install-global-source.mjs",
  "scripts/package-path.mjs", "scripts/clean-dist.mjs", "scripts/install-git-hooks.mjs",
  "scripts/sandbox-dependencies.mjs", "scripts/smoke-package.mjs",
  "scripts/smoke-source-prepare.mjs", "scripts/source-install-metadata.mjs",
  "scripts/source-update.mjs", "webui/package.json", "webui/package-lock.json",
  "runtime/executable.mjs", "runtime/private-file.mjs", "runtime/process-lifecycle.mjs",
  "runtime/gateway-config.mjs", "runtime/app-server-runtime.mjs", "runtime/app-server-supervisor.mjs",
  "runtime/gateway-owner.mjs", "runtime/service-targets.mjs",
]);
const gateInputs = new Set([
  "scripts/verification-scope.mjs", "scripts/verify-commit.mjs", "scripts/run-upgrade-validation.mjs",
  ".github/workflows/ci.yml", ".github/workflows/codex-upgrade-preview.yml", ".githooks/pre-commit",
]);
const appServerModules = [
  "src/codex-protocol/", "src/codex-client/", "src/conversation-core/",
  "src/session-routing/", "src/approval/", "src/application/", "src/bootstrap/",
  "src/config/", "src/policy/", "src/provider-proxy/",
];

export function parseChangedFiles(output) {
  if (output && !output.endsWith("\0")) throw new Error("Git 变更路径清单不完整");
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("Git 变更路径清单不完整");
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (!/^[ACDMTUXB]$/u.test(status) || !path) throw new Error("Git 变更路径清单无效");
    changes.push({ status, path });
  }
  return changes;
}

export function changedFiles(args, cwd = process.cwd()) {
  return parseChangedFiles(execFileSync("git", [
    "diff", "--name-status", "--no-renames", "-z", ...args,
  ], { cwd, encoding: "utf8" }));
}

export function verificationScope(changes) {
  const paths = changes.map(change => change.path).filter(path => !path.endsWith(".md"));
  return {
    package: paths.some(path => gateInputs.has(path) || packageFiles.has(path)
      || /^(?:bin|launchd|systemd)\//u.test(path)
      || /^scripts\/(?:install|source-install|source-update|update|background-update|windows-service|service-install|local-installation|local-source-deployment|runtime-config|workspace-config)/u.test(path)
      || /^tests\/(?:.*(?:install|package|prepare)|source-update).*\.(?:ts|mjs)$/u.test(path)),
    appServer: paths.some(path => gateInputs.has(path) || appServerModules.some(prefix => path.startsWith(prefix))
      || path === "package.json" || path === "package-lock.json"
      || path === "src/main.ts" || path === "src/version.json"
      || /^(?:runtime|bin|launchd|systemd)\//u.test(path)
      || /^scripts\/(?:.*(?:app-server|protocol|codex|service|model-provider)|sync-gateway-version|local-installation|local-source-deployment)/u.test(path)
      || /^tests\/(?:real-app-server|support\/real-app-server|fixtures\/)/u.test(path)
      || path === "config.example.toml"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some(value => !/^[0-9a-f]{7,64}$/u.test(value))) {
    throw new Error("用法：node scripts/verification-scope.mjs <base commit> <head commit>");
  }
  console.log(JSON.stringify(verificationScope(changedFiles([`${args[0]}..${args[1]}`]))));
}
