$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot '../dist/windows-native'
$source = Join-Path $PSScriptRoot '../runtime/windows-native.cs'
# The build owns this fixed output directory. A failed build must not retain a
# manifest that presents an older or partial DLL as the current source artifact.
[IO.Directory]::CreateDirectory($destination) | Out-Null
$manifestPath = Join-Path $destination 'manifest.json'
$assemblyPath = Join-Path $destination 'CodexcWindows.dll'
foreach ($artifact in @($manifestPath, $assemblyPath)) {
  if (Test-Path -LiteralPath $artifact) { Remove-Item -LiteralPath $artifact -Force }
}
Add-Type -LiteralPath $source -OutputAssembly $assemblyPath -OutputType Library
@{
  schemaVersion = 1
  powerShell = "$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)"
  runtimeMajor = [Environment]::Version.Major
  sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
  assemblyHash = (Get-FileHash -LiteralPath $assemblyPath -Algorithm SHA256).Hash
} | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
