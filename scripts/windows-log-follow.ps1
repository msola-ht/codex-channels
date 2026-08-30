param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 10000)]
  [int]$Lines,

  [Parameter(Mandatory = $true)]
  [string]$PathsJson
)

$ErrorActionPreference = 'Stop'

$Paths = @($PathsJson | ConvertFrom-Json)
if ($Paths.Count -eq 0 -or $Paths.Where({ $_ -isnot [string] -or $_.Length -eq 0 }).Count -gt 0) {
  throw '日志路径参数无效'
}
Get-Content -LiteralPath $Paths -Tail $Lines -Wait
