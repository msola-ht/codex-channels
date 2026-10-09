$ErrorActionPreference = 'Stop'

# Build artifacts belong to the installed package, never to private user storage.
$nativeDirectory = Join-Path $PSScriptRoot '../dist/windows-native'
$assemblyPath = Join-Path $nativeDirectory 'CodexcWindows.dll'
try {
  $manifest = Get-Content -LiteralPath (Join-Path $nativeDirectory 'manifest.json') -Raw | ConvertFrom-Json
  $assemblyBytes = [IO.File]::ReadAllBytes($assemblyPath)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $assemblyHash = [BitConverter]::ToString($hasher.ComputeHash($assemblyBytes)).Replace('-', '') }
  finally { $hasher.Dispose() }
  if ($manifest.schemaVersion -ne 1 -or
      $manifest.powerShell -ne "$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)" -or
      $manifest.runtimeMajor -ne [Environment]::Version.Major -or
      $manifest.sourceHash -ne (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'windows-native.cs') -Algorithm SHA256).Hash -or
      $manifest.assemblyHash -ne $assemblyHash) {
    throw 'Incompatible native artifact'
  }
  # Loading the verified bytes avoids locking the installed DLL during upgrades.
  [Reflection.Assembly]::Load($assemblyBytes) | Out-Null
} catch {
  throw 'Windows 原生构建产物缺失、不匹配或无法加载；请在当前 PowerShell 7 环境重新运行 npm run install:global；源码开发请运行 npm run build。'
}
