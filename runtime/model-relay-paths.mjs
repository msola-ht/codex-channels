import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export function modelRelayPaths(configPath) {
  const digest = createHash("sha256").update(resolve(configPath)).digest("hex").slice(0, 16);
  const directory = join(dirname(resolve(configPath)), "runtime");
  return { control: join(directory, `relay-control-${digest}.sock`), metrics: join(directory, `relay-metrics-${digest}.sock`) };
}
