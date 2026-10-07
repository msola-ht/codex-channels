// Regenerate archived schemas from pinned repository sources; not needed to run the upgrade.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import ts from 'typescript';

const baselines = [[28, 'a401723b'], [29, '1c4f314f'], [30, '679132a4']];
for (const [version, commit] of baselines) {
  const databaseSource = execFileSync('git', ['show', `${commit}:src/observability/request-metrics-database.ts`], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  });
  if (!databaseSource.includes(`export const modelRequestMetricsSchemaVersion = ${version};`)) {
    throw new Error(`Schema version does not match ${commit}`);
  }
  const source = execFileSync('git', ['show', `${commit}:src/observability/sqlite-request-metrics-schema.ts`], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  });
  const versionImport = 'import { modelRequestMetricsSchemaVersion } from "./request-metrics-database.js";';
  if (source.split(versionImport).length !== 2) throw new Error(`Unexpected schema import at ${commit}`);
  const output = ts.transpileModule(source.replace(versionImport,
    `const modelRequestMetricsSchemaVersion = ${version};`), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  writeFileSync(new URL(`./schema-v${version}.mjs`, import.meta.url),
    `// Generated from ${commit}:src/observability/sqlite-request-metrics-schema.ts.\n// Regenerate with node database-upgrades/generate-historical-schemas.mjs.\n${output}`);
}
