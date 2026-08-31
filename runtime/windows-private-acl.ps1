$ErrorActionPreference = 'Stop'

function Throw-InvalidAcl([string]$Message) {
  throw [System.InvalidOperationException]::new($Message)
}

function Get-Request {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) {
    Throw-InvalidAcl '缺少 ACL 请求'
  }
  $request = $raw | ConvertFrom-Json
  if ($request.operation -notin @('secure', 'verify')) {
    Throw-InvalidAcl 'ACL 操作无效'
  }
  if ($request.kind -notin @('file', 'directory', 'parent-directory')) {
    Throw-InvalidAcl 'ACL 路径类型无效'
  }
  if ([string]::IsNullOrWhiteSpace($request.path)) {
    Throw-InvalidAcl 'ACL 路径无效'
  }
  if ($request.operation -eq 'secure' -and $request.kind -eq 'parent-directory') {
    Throw-InvalidAcl '父目录只支持校验'
  }
  return $request
}

function Get-PathItem([string]$Path, [string]$Kind) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Throw-InvalidAcl '私有路径不能是重解析点'
  }
  if ($Kind -eq 'file' -and $item.PSIsContainer) {
    Throw-InvalidAcl '私有路径必须是普通文件'
  }
  if ($Kind -ne 'file' -and -not $item.PSIsContainer) {
    Throw-InvalidAcl '私有路径必须是目录'
  }
  return $item
}

function Get-ExpectedSids {
  return @(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  )
}

function Set-PrivateAcl($Item, [string]$Kind, $ExpectedSids) {
  $sections = [System.Security.AccessControl.AccessControlSections]::Owner `
    -bor [System.Security.AccessControl.AccessControlSections]::Group `
    -bor [System.Security.AccessControl.AccessControlSections]::Access
  $security = [System.IO.FileSystemAclExtensions]::GetAccessControl($Item, $sections)
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($owner.Value -ne $ExpectedSids[0].Value) {
    Throw-InvalidAcl '私有路径必须由当前 SID 拥有'
  }
  if ($Kind -eq 'file') {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  } else {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit `
      -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  $security.SetAccessRuleProtection($true, $false)
  $existingRules = $security.GetAccessRules(
    $true,
    $false,
    [System.Security.Principal.SecurityIdentifier]
  )
  $purgedSids = @{}
  foreach ($rule in $existingRules) {
    $sid = $rule.IdentityReference
    if (-not $purgedSids.ContainsKey($sid.Value)) {
      $security.PurgeAccessRules($sid)
      $purgedSids[$sid.Value] = $true
    }
  }
  foreach ($sid in $ExpectedSids) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  [System.IO.FileSystemAclExtensions]::SetAccessControl($Item, $security)
}

function Assert-PrivateAcl($Item, [string]$Kind, $ExpectedSids) {
  $security = [System.IO.FileSystemAclExtensions]::GetAccessControl(
    $Item,
    [System.Security.AccessControl.AccessControlSections]::Owner `
      -bor [System.Security.AccessControl.AccessControlSections]::Access
  )
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($owner.Value -ne $ExpectedSids[0].Value) {
    Throw-InvalidAcl '私有路径必须由当前 SID 拥有'
  }
  $expected = @{}
  foreach ($sid in $ExpectedSids) {
    $expected[$sid.Value] = $false
  }
  $dangerousRights = [System.Security.AccessControl.FileSystemRights]::WriteData `
    -bor [System.Security.AccessControl.FileSystemRights]::AppendData `
    -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes `
    -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles `
    -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes `
    -bor [System.Security.AccessControl.FileSystemRights]::Delete `
    -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions `
    -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  $rules = $security.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  )
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      continue
    }
    $sid = $rule.IdentityReference.Value
    if ($expected.ContainsKey($sid)) {
      if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) `
        -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
        Throw-InvalidAcl '受信任 SID 缺少完全控制权限'
      }
      $expected[$sid] = $true
      continue
    }
    if ($Kind -ne 'parent-directory' -or ($rule.FileSystemRights -band $dangerousRights) -ne 0) {
      Throw-InvalidAcl '其他主体具有不安全的私有路径访问权限'
    }
  }
  foreach ($sid in $ExpectedSids) {
    if (-not $expected[$sid.Value]) {
      Throw-InvalidAcl '私有路径缺少受信任 SID 权限'
    }
  }
  if ($Kind -ne 'parent-directory' -and -not $security.AreAccessRulesProtected) {
    Throw-InvalidAcl '私有路径仍继承父目录权限'
  }
}

$request = Get-Request
$item = Get-PathItem $request.path $request.kind
$expectedSids = Get-ExpectedSids
if ($request.operation -eq 'secure') {
  Set-PrivateAcl $item $request.kind $expectedSids
  $item = Get-PathItem $request.path $request.kind
}
Assert-PrivateAcl $item $request.kind $expectedSids
@{ ok = $true } | ConvertTo-Json -Compress
