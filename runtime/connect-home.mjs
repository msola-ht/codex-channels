import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function connectHomePath(environment = process.env) {
  return resolve(
    environment.CODEX_CONNECT_HOME?.trim() || join(homedir(), ".codex-connect"),
  );
}

export function providerStorageRoot(environment = process.env) {
  return join(connectHomePath(environment), "providers");
}
