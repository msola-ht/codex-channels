import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const marker = "# Codex Connect";
const legacyPathLines = new Set([
  'export PATH="$HOME/.codex-connect/bin:$PATH"',
  'export PATH="$HOME/.codex-connect/.bin:$PATH"',
]);

export function removeLegacySourceShellPaths(environment = process.env) {
  const home = environment.HOME;
  if (!home) return [];
  const changed = [];
  for (const profileName of [".zshrc", ".bashrc", ".bash_profile", ".profile"]) {
    const profile = join(home, profileName);
    if (!existsSync(profile)) continue;
    const content = readFileSync(profile, "utf8");
    const next = removeManagedLines(content);
    if (next === content) continue;
    writeFileSync(profile, next);
    changed.push(profile);
  }
  return changed;
}

function removeManagedLines(content) {
  const lines = content.split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === marker && legacyPathLines.has(lines[index + 1])) {
      if (kept.at(-1) === "") kept.pop();
      index += 1;
      continue;
    }
    if (legacyPathLines.has(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3 || process.argv[2] !== "remove") {
    process.stderr.write("用法：source-shell-path.mjs remove\n");
    process.exitCode = 1;
  } else {
    removeLegacySourceShellPaths();
  }
}
