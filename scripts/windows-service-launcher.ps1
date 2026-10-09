param(
  [Parameter(Mandatory = $true)]
  [string]$DefinitionPath
)

$ErrorActionPreference = 'Stop'

$definition = Get-Content -LiteralPath $DefinitionPath -Raw -Encoding utf8 | ConvertFrom-Json
Set-Location -LiteralPath $definition.workingDirectory
$maximumRestarts = 3
$restartDelaySeconds = 5
Add-Type -Path (Join-Path $PSScriptRoot '..\runtime\windows-native.cs')

for ($attempt = 0; $attempt -le $maximumRestarts; $attempt += 1) {
  $exitCode = [CodexcWindows.OwnedProcess]::Run($definition.nodeBinary,
    [string[]]@('--disable-warning=ExperimentalWarning', $definition.serviceHost, $DefinitionPath), $false, $definition.workingDirectory)
  if ($exitCode -eq 0 -or $attempt -eq $maximumRestarts) {
    exit $exitCode
  }
  Start-Sleep -Seconds $restartDelaySeconds
}
