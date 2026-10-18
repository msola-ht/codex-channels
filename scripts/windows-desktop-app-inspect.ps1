$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
    Sort-Object Version -Descending)
if ($packages.Count -eq 0) {
    [pscustomobject]@{ installed = $false } | ConvertTo-Json -Compress
    exit 0
}

$package = $packages[0]
$installRoot = [IO.Path]::GetFullPath([string]$package.InstallLocation)
$executablePath = $null
foreach ($relativePath in @('app\ChatGPT.exe', 'app\Codex.exe')) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $installRoot $relativePath))
    $rootPrefix = $installRoot.TrimEnd([char[]]@(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )) + [IO.Path]::DirectorySeparatorChar
    if ($candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $executablePath = $candidate
        break
    }
}

$running = $null
if ($executablePath) {
    try {
        $executableName = [IO.Path]::GetFileName($executablePath).Replace("'", "''")
        $processes = @(Get-CimInstance Win32_Process -Filter "Name = '$executableName'" -ErrorAction Stop)
        $running = $false
        foreach ($process in $processes) {
            $processPath = [string]$process.ExecutablePath
            if ([string]::IsNullOrWhiteSpace($processPath) -or
                -not [IO.Path]::IsPathFullyQualified($processPath)) {
                $running = $null
                continue
            }
            try {
                $processPath = [IO.Path]::GetFullPath($processPath)
            } catch {
                $running = $null
                continue
            }
            if ([string]::Equals($processPath, $executablePath, [StringComparison]::OrdinalIgnoreCase)) {
                $running = $true
                break
            }
        }
    } catch {
        $running = $null
    }
}

[pscustomobject]@{
    installed = $true
    executablePath = $executablePath
    resourcePath = [IO.Path]::GetFullPath((Join-Path $installRoot 'app\resources\app.asar'))
    version = [string]$package.Version
    running = $running
} | ConvertTo-Json -Compress
