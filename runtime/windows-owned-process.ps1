param([Parameter(Mandatory = $true)][string]$Invocation)
$ErrorActionPreference = 'Stop'
$guard = $null
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-native.cs')
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Invocation)) | ConvertFrom-Json
  if (-not [IO.Path]::IsPathFullyQualified($request.file) -or $request.args -isnot [array]) { throw 'Invalid invocation' }
  if ($request.socketPath) {
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
  }
  $code = [CodexcWindows.OwnedProcess]::Run($request.file, [string[]]$request.args, [bool]$request.windowsVerbatimArguments, (Get-Location).ProviderPath)
  exit $code
} catch {
  # Do not print invocation arguments, environment or raw exceptions.
  [Console]::Error.WriteLine('Windows owned process failed: startup, private endpoint validation or job cleanup failed')
  exit 1
} finally {
  if ($null -ne $guard) { $guard.Dispose() }
}
