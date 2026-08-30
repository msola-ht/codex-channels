param(
  [Parameter(Mandatory = $true)]
  [string]$DefinitionPath
)

$ErrorActionPreference = 'Stop'

$definition = Get-Content -LiteralPath $DefinitionPath -Raw -Encoding utf8 | ConvertFrom-Json
Set-Location -LiteralPath $definition.workingDirectory
& $definition.nodeBinary '--disable-warning=ExperimentalWarning' $definition.serviceHost $DefinitionPath
exit $LASTEXITCODE
