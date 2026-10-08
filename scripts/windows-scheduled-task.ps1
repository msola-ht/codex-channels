param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('register', 'start', 'stop', 'unregister', 'query')]
  [string]$Action,

  [string]$TaskName,

  [string]$TaskNamesJson,

  [string]$DefinitionPath
)

$ErrorActionPreference = 'Stop'

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
    $definition = Get-Content -LiteralPath $DefinitionPath -Raw -Encoding utf8 | ConvertFrom-Json
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
    $task = Get-ExactTask $TaskName
    if ($task -and [int]$task.State -ne 3) {
      $task.Stop(0)
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
