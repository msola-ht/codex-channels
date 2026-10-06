import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("Windows installer Codex synchronization", () => {
  it.each(["missing", "mismatch", "matching", "install-fails", "wrong-path", "broken-command"])("handles %s without touching the real global installation", scenario => {
    const root = mkdtempSync(join(tmpdir(), "codexc-win-installer-"));
    try {
      const codex = join(root, "fixture-codex.ps1");
      writeFileSync(codex, "$global:LASTEXITCODE = if ($env:FIXTURE_SCENARIO -eq 'broken-command') { 1 } else { 0 }; Write-Output ('codex-cli ' + $global:fixtureVersion)\n");
      const harness = join(root, "harness.ps1");
      writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:FIXTURE_INSTALLER, [ref]$null, [ref]$null)
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Read-CodexVersion', 'Ensure-CodexCli') }, $false)
. ([ScriptBlock]::Create(($functions.Extent.Text -join "\n")))
$global:fixtureVersion = if ($env:FIXTURE_SCENARIO -eq 'matching') { '1.2.3' } else { '1.0.0' }
$global:installs = 0
function Get-Command { param($Name) return [pscustomobject]@{ Source = $env:FIXTURE_CODEX } }
function Invoke-Checked { param($File, $Arguments, $WorkingDirectory)
  if ($Arguments[-1] -ne '@openai/codex@1.2.3') { throw 'wrong target' }
  $global:installs++
  if ($env:FIXTURE_SCENARIO -eq 'install-fails') { throw 'fixture install failed' }
  if ($env:FIXTURE_SCENARIO -ne 'wrong-path') { $global:fixtureVersion = '1.2.3' }
  Write-Output 'fixture npm installation output'
}
$command = if ($env:FIXTURE_SCENARIO -eq 'missing') { $null } else { Get-Command codex }
$failure = $null
try {
  $resolved = Ensure-CodexCli $command '1.2.3' 'fixture-npm' $env:TEMP
  if ($resolved -is [array] -or $resolved.Source -ne $env:FIXTURE_CODEX) { throw 'installer did not return one command' }
} catch { $failure = $_.Exception.Message }
@{ installs = $global:installs; failure = $failure } | ConvertTo-Json -Compress
`);
      const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {
        encoding: "utf8", env: { ...process.env, FIXTURE_SCENARIO: scenario, FIXTURE_CODEX: codex, FIXTURE_INSTALLER: resolve("install.ps1") },
      });
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)!);
      expect(value.installs).toBe(["matching", "broken-command"].includes(scenario) ? 0 : 1);
      if (["missing", "mismatch", "matching"].includes(scenario)) expect(value.failure).toBeNull();
      else expect(value.failure).toContain(scenario === "install-fails" ? "fixture install failed" : scenario === "wrong-path" ? "PATH" : "无法执行");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
