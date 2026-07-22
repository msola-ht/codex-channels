import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { packageDir } from "./runtime-config.mjs";

const packageMetadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const destination = join(packageDir, "src", "version.json");
writeFileSync(destination, `${JSON.stringify({ version: packageMetadata.version }, null, 2)}\n`);
console.log(`Gateway 版本已同步：${packageMetadata.version}`);
