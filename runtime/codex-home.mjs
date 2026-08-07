import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function codexHomePath(environment = process.env) {
  return resolve(environment.CODEX_HOME?.trim() || join(homedir(), ".codex"));
}
