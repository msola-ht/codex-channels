import { serviceIdentifiers } from "../runtime/service-targets.mjs";

const platform = process.argv[2];
const target = process.argv[3];
const order = process.argv[4];
if (
  (platform !== "systemd" && platform !== "launchd")
  || target === undefined
) {
  throw new Error(
    "用法：service-target-query.mjs <systemd|launchd> <gateway|app-server|webui|center|all> [start|stop]",
  );
}
const identifiers = serviceIdentifiers(platform, target, order);
for (const identifier of identifiers) {
  console.log(identifier);
}
