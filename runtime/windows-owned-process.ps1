param([Parameter(Mandatory = $true)][string]$Invocation)
$ErrorActionPreference = 'Stop'
$guard = $null
$owner = $null
$stage = 'load'
try {
  . (Join-Path $PSScriptRoot 'windows-native-load.ps1')
  $stage = 'invocation'
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Invocation)) | ConvertFrom-Json
  if (-not [IO.Path]::IsPathFullyQualified($request.file) -or $request.args -isnot [array]) { throw 'Invalid invocation' }
  $stage = 'owner'
  $owner = [CodexcWindows.ProcessOwner]::new([uint32]$request.ownerPid)
  if ($request.socketPath) {
    $stage = 'socket-directory'
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($request.socketPath))
    $guard = [CodexcWindows.DirectoryGuard]::new($parent)
    $acl = Get-Acl -LiteralPath $parent
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { throw 'Invalid socket ACL' }
    $rule = $rules[0]
    if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'Invalid socket ACL' }
    $guard.ProtectContents()
  }
  $stage = 'process'
  $code = [CodexcWindows.OwnedProcess]::Run($request.file, [string[]]$request.args, [bool]$request.windowsVerbatimArguments, (Get-Location).ProviderPath, $owner)
  exit $code
} catch {
  # Do not print invocation arguments, environment or raw exceptions.
  $failure = $_.Exception
  $nativeCode = $null
  while ($null -ne $failure) {
    if ($failure -is [ComponentModel.Win32Exception]) { $nativeCode = $failure.NativeErrorCode }
    $failure = $failure.InnerException
  }
  $detail = if ($null -ne $nativeCode) { "; win32=$nativeCode" } else { '' }
  [Console]::Error.WriteLine("Windows owned process failed: stage=$stage$detail")
  if ($stage -eq 'load') {
    [Console]::Error.WriteLine('请在当前 PowerShell 7 环境重新运行 npm run install:global；源码开发请运行 npm run build。')
  }
  exit 1
} finally {
  if ($null -ne $guard) { $guard.Dispose() }
  if ($null -ne $owner) { $owner.Dispose() }
}
