import { pathToFileURL } from "node:url";
import { runSupervisedCliWorker } from "../runtime/owned-command-worker.mjs";

export { supervisedCliInvocation } from "../runtime/owned-command-worker.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSupervisedCliWorker();
}
