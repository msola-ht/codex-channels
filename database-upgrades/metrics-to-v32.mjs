import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { metricsUpgradeHelp, upgradeMetrics } from '../scripts/metrics-database-upgrade.mjs';

export { inspectMetricsUpgrade, upgradeMetrics } from '../scripts/metrics-database-upgrade.mjs';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
    console.log(metricsUpgradeHelp);
  } else if (args.length !== 3 || args.some(arg => arg.startsWith('-'))) {
    console.error(metricsUpgradeHelp);
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await upgradeMetrics(...args))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
