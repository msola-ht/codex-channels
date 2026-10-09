param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('register', 'start', 'stop', 'unregister', 'query')]
  [string]$Action,

  [string]$TaskName,

  [string]$TaskNamesJson,

  [string]$DefinitionPath
)

$ErrorActionPreference = 'Stop'
trap {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}

if ($TaskNamesJson) {
  if ($Action -ne 'query' -or $TaskName) {
    throw '批量计划任务名称仅适用于查询，且不能与 TaskName 同时提供'
  }
  $taskNames = ConvertFrom-Json -InputObject $TaskNamesJson -NoEnumerate
  if ($taskNames -isnot [array] -or $taskNames.Count -eq 0) {
    throw '批量计划任务名称必须为非空 JSON 数组'
  }
} else {
  $taskNames = @($TaskName)
}
foreach ($name in $taskNames) {
  if ($name -isnot [string] -or [string]::IsNullOrWhiteSpace($name) -or $name -match '[\\/\x00]') {
    throw '计划任务名称必须为根目录下的完整名称'
  }
}
if (@($taskNames | Select-Object -Unique).Count -ne $taskNames.Count) {
  throw '批量计划任务名称不能重复'
}

function Read-ServiceDefinition {
  if (-not $DefinitionPath) { throw '必须提供服务定义路径' }
  try {
    return Get-Content -LiteralPath $DefinitionPath -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    # JSON parser errors may echo environment values from the definition.
    throw 'Windows 服务定义无法读取或 JSON 无效；请运行 codexc install'
  }
}

if ($Action -eq 'start') {
  $definition = Read-ServiceDefinition
  if ($definition.version -ne 1 -or $definition.taskName -cne $TaskName) {
    throw '服务定义与计划任务不匹配；请运行 codexc install'
  }
  foreach ($field in @('pwshBinary', 'nodeBinary', 'serviceHost', 'launcherPath', 'vbsLauncherPath')) {
    $path = $definition.$field
    if ($path -isnot [string] -or -not [IO.Path]::IsPathFullyQualified($path) -or
        -not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "服务定义的 $field 文件缺失或无效；请运行 codexc install"
    }
  }
  if ($definition.workingDirectory -isnot [string] -or
      -not [IO.Path]::IsPathFullyQualified($definition.workingDirectory) -or
      -not (Test-Path -LiteralPath $definition.workingDirectory -PathType Container)) {
    throw '服务定义的 workingDirectory 目录缺失或无效；请运行 codexc install'
  }
  $commands = @{ 'app-server' = 'service-app-server'; gateway = 'gateway'; webui = 'webui'; 'model-relay' = 'service-model-relay' }
  if ($definition.arguments -isnot [array] -or $definition.arguments.Count -ne 3 -or
      $definition.arguments[0] -cne '--disable-warning=ExperimentalWarning' -or
      $definition.target -isnot [string] -or -not $commands.ContainsKey($definition.target) -or
      $definition.arguments[2] -cne $commands[$definition.target] -or
      $definition.arguments[1] -isnot [string] -or
      -not [IO.Path]::IsPathFullyQualified($definition.arguments[1]) -or
      -not (Test-Path -LiteralPath $definition.arguments[1] -PathType Leaf)) {
    throw '服务定义的 CLI 启动入口缺失或无效；请运行 codexc install'
  }
  $currentProcess = [Diagnostics.Process]::GetCurrentProcess()
  try { $currentPwsh = $currentProcess.MainModule.FileName }
  finally { $currentProcess.Dispose() }
  if (-not [string]::Equals([IO.Path]::GetFullPath($definition.pwshBinary),
      [IO.Path]::GetFullPath($currentPwsh), [StringComparison]::OrdinalIgnoreCase)) {
    throw '服务定义的 PowerShell 与当前验证宿主不一致；请运行 codexc install'
  }
  # Validate the artifacts used by the actual launcher, in its defined pwsh.
  # This only reads and loads build artifacts; it does not start the task or host.
  $nativeLoader = Join-Path ([IO.Path]::GetDirectoryName($definition.launcherPath)) '../runtime/windows-native-load.ps1'
  if (-not (Test-Path -LiteralPath $nativeLoader -PathType Leaf)) {
    throw 'Windows 原生构建加载器缺失；请重新运行 npm run install:global；源码开发请运行 npm run build'
  }
  . $nativeLoader
}

if ($Action -ne 'register') {
  # Local computer and current token only; do not enumerate or match wildcards.
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $taskFolder = $scheduler.GetFolder('\')
}

function Get-ExactTask([string]$Name) {
  try {
    return $taskFolder.GetTask($Name)
  } catch {
    $exception = $_.Exception
    while ($exception.InnerException) { $exception = $exception.InnerException }
    # Only ERROR_FILE_NOT_FOUND means absent; access/transport failures propagate.
    if ($exception.HResult -eq -2147024894) { return $null }
    throw
  }
}

function Get-TaskStatus([string]$Name) {
  $task = Get-ExactTask $Name
  if (-not $task) {
    return @{ taskName = $Name; exists = $false; state = 'missing'; lastTaskResult = $null }
  }
  $states = @('Unknown', 'Disabled', 'Queued', 'Ready', 'Running')
  $state = [int]$task.State
  if ($state -lt 0 -or $state -ge $states.Count) { throw '计划任务状态无效' }
  return @{
    taskName = $Name
    exists = $true
    state = $states[$state]
    lastTaskResult = [int64]$task.LastTaskResult
  }
}

switch ($Action) {
  'register' {
    if (-not $DefinitionPath) {
      throw '注册计划任务时必须提供服务定义路径'
    }
    $definition = Read-ServiceDefinition
    if (-not $definition.vbsLauncherPath) {
      throw '服务定义缺少隐藏启动器路径；请运行 codexc install'
    }
    $quotedVbsLauncher = '"' + $definition.vbsLauncherPath.Replace('"', '\"') + '"'
    $wscriptBinary = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $taskAction = New-ScheduledTaskAction -Execute $wscriptBinary -Argument "//B //NoLogo $quotedVbsLauncher"
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $autoStart = if ($null -eq $definition.autoStart) {
      $definition.target -in @('app-server', 'gateway')
    } else {
      [bool]$definition.autoStart
    }
    $trigger = $null
    if ($autoStart) {
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
      $trigger.CimInstanceProperties['Delay'].Value = if ($definition.target -eq 'gateway') {
        'PT2M'
      } else {
        'PT1M'
      }
    }
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -MultipleInstances IgnoreNew `
      -ExecutionTimeLimit ([TimeSpan]::Zero)
    $registration = @{
      TaskName = $TaskName
      Action = $taskAction
      Principal = $principal
      Settings = $settings
      Description = $definition.description
      Force = $true
    }
    if ($trigger) {
      $registration.Trigger = $trigger
    }
    Register-ScheduledTask @registration | Out-Null
  }
  'start' {
    $task = Get-ExactTask $TaskName
    if (-not $task) { throw "计划任务不存在：$TaskName" }
    if ([int]$task.State -ne 4) { $task.Run($null) | Out-Null }
  }
  'stop' {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $task = Get-ExactTask $TaskName
    if ($task -and [int]$task.State -notin @(1, 3)) {
      $task.Stop(0)
      do {
        $task = Get-ExactTask $TaskName
        if (-not $task -or [int]$task.State -in @(1, 3)) { break }
        if ([DateTime]::UtcNow -ge $deadline) {
          throw "计划任务启动器尚未确认停止：$TaskName"
        }
        Start-Sleep -Milliseconds 250
      } while ($true)
    }
  }
  'unregister' {
    $task = Get-ExactTask $TaskName
    if ($task) {
      $taskFolder.DeleteTask($TaskName, 0)
    }
  }
  'query' {
    if ($TaskNamesJson) {
      $statuses = @($taskNames | ForEach-Object { Get-TaskStatus $_ })
      @{ tasks = $statuses } | ConvertTo-Json -Depth 3 -Compress
    } else {
      $status = Get-TaskStatus $TaskName
      $status.Remove('taskName')
      $status | ConvertTo-Json -Compress
    }
  }
}
