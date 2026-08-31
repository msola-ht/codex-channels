param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('register', 'start', 'stop', 'unregister', 'query')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$TaskName,

  [string]$DefinitionPath
)

$ErrorActionPreference = 'Stop'

function Get-ExactTask {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -eq $TaskName } |
    Select-Object -First 1
}

switch ($Action) {
  'register' {
    if (-not $DefinitionPath) {
      throw '注册计划任务时必须提供服务定义路径'
    }
    $definition = Get-Content -LiteralPath $DefinitionPath -Raw -Encoding utf8 | ConvertFrom-Json
    $quotedLauncher = '"' + $definition.launcherPath.Replace('"', '\"') + '"'
    $quotedDefinition = '"' + $DefinitionPath.Replace('"', '\"') + '"'
    $arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $quotedLauncher -DefinitionPath $quotedDefinition"
    $taskAction = New-ScheduledTaskAction -Execute $definition.pwshBinary -Argument $arguments
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
    $task = Get-ExactTask
    if (-not $task) { throw "计划任务不存在：$TaskName" }
    Start-ScheduledTask -InputObject $task
  }
  'stop' {
    $task = Get-ExactTask
    if ($task -and $task.State -ne 'Ready') {
      Stop-ScheduledTask -InputObject $task
    }
  }
  'unregister' {
    $task = Get-ExactTask
    if ($task) {
      Unregister-ScheduledTask -InputObject $task -Confirm:$false
    }
  }
  'query' {
    $task = Get-ExactTask
    if (-not $task) {
      @{ exists = $false; state = 'missing'; lastTaskResult = $null } |
        ConvertTo-Json -Compress
      break
    }
    $info = Get-ScheduledTaskInfo -InputObject $task
    @{
      exists = $true
      state = [string]$task.State
      lastTaskResult = [int64]$info.LastTaskResult
    } | ConvertTo-Json -Compress
  }
}
