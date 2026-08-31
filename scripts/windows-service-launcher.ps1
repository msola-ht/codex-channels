param(
  [Parameter(Mandatory = $true)]
  [string]$DefinitionPath
)

$ErrorActionPreference = 'Stop'

$definition = Get-Content -LiteralPath $DefinitionPath -Raw -Encoding utf8 | ConvertFrom-Json
Set-Location -LiteralPath $definition.workingDirectory
$maximumRestarts = 3
$restartDelaySeconds = 5

for ($attempt = 0; $attempt -le $maximumRestarts; $attempt += 1) {
  & $definition.nodeBinary '--disable-warning=ExperimentalWarning' $definition.serviceHost $DefinitionPath
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0 -or $attempt -eq $maximumRestarts) {
    exit $exitCode
  }
  Start-Sleep -Seconds $restartDelaySeconds
}
