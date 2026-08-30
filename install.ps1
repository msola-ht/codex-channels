param(
  [switch]$Help,
  [string]$Repository,
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$repository = if ([string]::IsNullOrWhiteSpace($Repository)) {
  'https://github.com/msola-ht/codex-channels.git'
} else {
  $Repository
}

function Show-Usage {
  @'
用法：install.ps1

把 Codex Connect 的 main 分支安装到 $env:USERPROFILE\.codex-connect\codex-channels。
只支持 Windows PowerShell 7；不要求管理员权限。
'@ | Write-Output
}

if ($Help) {
  Show-Usage
  exit 0
}
if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) {
  throw '源码安装当前只支持 Windows PowerShell 7（pwsh）'
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$File 执行失败：exit=$LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Invoke-Captured([string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location -LiteralPath $WorkingDirectory
  try {
    $output = & $File @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "$File 执行失败：$output"
  }
  return $output.Trim()
}

function Protect-Directory([string]$Path, [string]$WorkingDirectory) {
  Invoke-Checked 'node.exe' @('--input-type=module', '--eval', "import { securePrivateDirectorySync } from './runtime/private-file.mjs'; securePrivateDirectorySync(process.argv[1]);", $Path) $WorkingDirectory
}

$git = (Get-Command git.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$codexCommand = Get-Command codex -ErrorAction SilentlyContinue
if (-not $git -or -not $node -or -not $npm) { throw '缺少必需命令：git、node 或 npm' }

$nodeVersion = [version]((& $node '--version').Trim().TrimStart('v'))
if ($nodeVersion -lt [version]'22.13.0') { throw 'Node.js 版本过低；需要 22.13.0 或更高版本' }
$npmVersion = (& $npm '--version').Trim()
$npmRoot = (& $npm 'root' '--global').Trim()
$npmPrefix = (& $npm 'prefix' '--global').Trim()
if ($LASTEXITCODE -ne 0 -or -not [System.IO.Path]::IsPathRooted($npmRoot) -or -not [System.IO.Path]::IsPathRooted($npmPrefix)) {
  throw '无法读取 npm 全局目录'
}
Write-Output "[提示] npm 检测通过：$npmVersion；全局目录：$npmRoot"
$manifest = Join-Path $npmRoot '@hegenai\codexc\package.json'
if (Test-Path -LiteralPath $manifest) {
  $metadata = Get-Content -LiteralPath $manifest -Raw -Encoding utf8 | ConvertFrom-Json
  Write-Output "[提示] 检测到 npm 全局版 @hegenai/codexc@$($metadata.version)；将由当前 main 构建替换。"
} else {
  Write-Output '[提示] 未检测到 npm 全局版 @hegenai/codexc。'
}

$userProfile = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($userProfile)) { throw 'USERPROFILE 未设置' }
$installRoot = if ([string]::IsNullOrWhiteSpace($env:CODEX_CONNECT_HOME)) { Join-Path $userProfile '.codex-connect' } else { $env:CODEX_CONNECT_HOME }
if (-not [System.IO.Path]::IsPathRooted($installRoot)) { throw 'CODEX_CONNECT_HOME 必须是绝对路径' }
$installRoot = [System.IO.Path]::GetFullPath($installRoot)
$checkout = Join-Path $installRoot 'codex-channels'
if (Test-Path -LiteralPath $checkout) { throw "源码目录已存在：$checkout；已有源码安装请使用 codexc update" }
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null

$staging = Join-Path $installRoot ('.codex-channels-install.' + [guid]::NewGuid().ToString('N'))
$repositoryRoot = Join-Path $staging 'repository'
$completed = $false
try {
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  Write-Output "[提示] 正在克隆 Codex Connect $Branch 到 $checkout"
  Invoke-Checked $git @('-c', 'core.longpaths=true', 'clone', '--quiet', '--branch', $Branch, '--single-branch', $repository, $repositoryRoot) $installRoot
  Protect-Directory $staging $repositoryRoot

  $versionDocument = Get-Content -LiteralPath (Join-Path $repositoryRoot 'src\codex-protocol\version.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $version = ([string]$versionDocument.codexCli) -replace '^codex-cli ', ''
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw '源码协议元数据缺少正式 Codex CLI 版本' }
  if (-not $codexCommand) {
    Write-Output "[提示] 未检测到 Codex CLI，正在安装 @openai/codex@$version"
    Invoke-Checked $npm @('install', '--global', '--no-audit', '--no-fund', "@openai/codex@$version") $repositoryRoot
    $codexCommand = Get-Command codex -ErrorAction Stop
  }
  $codexVersion = ((& $codexCommand.Source '--version').Trim() -split '\s+')[-1].TrimStart('v')
  if ($codexVersion -ne $version) { throw "Codex CLI 版本不匹配：main 需要 $version，当前 $($codexVersion ?? '未知')" }
  & $codexCommand.Source 'login' 'status' *> $null
  $loginState = if ($LASTEXITCODE -eq 0) { '已登录' } else { '未登录或登录状态不可用' }
  Write-Output "[提示] Codex CLI 检测通过：$($codexCommand.Source) · $codexVersion · $loginState"

  Write-Output '[提示] 正在安装依赖并构建 Gateway'
  Invoke-Checked $npm @('ci', '--no-audit', '--no-fund') $repositoryRoot
  Invoke-Checked $npm @('run', 'build') $repositoryRoot
  Invoke-Checked $npm @('run', 'check') $repositoryRoot
  Write-Output '[提示] 正在安装依赖并构建 WebUI'
  $webui = Join-Path $repositoryRoot 'webui'
  Invoke-Checked $npm @('ci', '--ignore-scripts', '--no-audit', '--no-fund') $webui
  Invoke-Checked $npm @('run', 'build') $webui
  if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'dist\main.js')) -or -not (Test-Path -LiteralPath (Join-Path $webui 'dist\index.html'))) {
    throw '构建结果不完整'
  }

  Invoke-Checked $git @('config', '--local', 'codex-connect.managed-source', 'true') $repositoryRoot
  Invoke-Checked $git @('config', '--local', 'codex-connect.npm-prefix', $npmPrefix) $repositoryRoot
  Move-Item -LiteralPath $repositoryRoot -Destination $checkout
  $packageDirectory = Join-Path $staging 'package'
  New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null
  $packJson = Invoke-Captured $npm @('pack', '--ignore-scripts', '--loglevel=error', '--json', '--pack-destination', $packageDirectory) $checkout
  $packEntry = @($packJson | ConvertFrom-Json)[0]
  if (-not $packEntry.filename) { throw 'npm pack 未返回 tarball 文件名' }
  Invoke-Checked $npm @('install', '--global', '--ignore-scripts', '--loglevel=error', '--no-audit', '--no-fund', (Join-Path $packageDirectory $packEntry.filename)) $checkout
  if (-not (Test-Path -LiteralPath (Join-Path $npmPrefix 'codexc.cmd'))) { throw "npm 全局命令入口不存在：$npmPrefix\codexc.cmd" }
  $completed = $true
  Write-Output "[成功] Codex Connect Git 源码已安装：$checkout"
  Write-Output '[提示] 下一步：codexc init && codexc setup && codexc service install'
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  if (-not $completed -and (Test-Path -LiteralPath $checkout)) { Remove-Item -LiteralPath $checkout -Recurse -Force }
}
