import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
