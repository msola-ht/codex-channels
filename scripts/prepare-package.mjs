import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { packageDir } from "./runtime-config.mjs";

const sourceConfig = join(packageDir, "tsconfig.build.json");
const builtEntry = join(packageDir, "dist", "gateway", "src", "main.js");

if (existsSync(sourceConfig)) {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} else if (!existsSync(builtEntry)) {
  throw new Error("npm 包缺少已构建的 Gateway 入口");
}
