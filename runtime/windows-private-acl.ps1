$ErrorActionPreference = 'Stop'

# Node sends and decodes this private JSON protocol as UTF-8. Do not inherit a
# Windows console code page, which can corrupt paths or localized ACL reasons.
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Throw-InvalidAcl([string]$Message) {
  $aclError = [System.InvalidOperationException]::new($Message)
  $aclError.Data['codexcAclReason'] = $Message
  throw $aclError
}

function Get-Request {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) {
    Throw-InvalidAcl '缺少 ACL 请求'
  }
  $request = $raw | ConvertFrom-Json
  if ($request.operation -notin @('secure', 'verify', 'read-config', 'repair')) {
    Throw-InvalidAcl 'ACL 操作无效'
  }
  if ($request.kind -notin @('file', 'directory', 'parent-directory', 'socket-directory')) {
    Throw-InvalidAcl 'ACL 路径类型无效'
  }
  if ([string]::IsNullOrWhiteSpace($request.path)) {
    Throw-InvalidAcl 'ACL 路径无效'
  }
  if ($request.operation -eq 'secure' -and $request.kind -eq 'parent-directory') {
    Throw-InvalidAcl '父目录只支持校验'
  }
  if ($request.operation -eq 'read-config' -and $request.kind -ne 'file') {
    Throw-InvalidAcl '配置读取只支持普通文件'
  }
  if ($request.operation -eq 'repair' -and $request.kind -ne 'file') {
    Throw-InvalidAcl '权限修复只支持普通文件'
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

function Set-PrivateAcl($Item, [string]$Kind, $ExpectedSids, [bool]$RepairOwner = $false) {
  $sections = [System.Security.AccessControl.AccessControlSections]::Owner `
    -bor [System.Security.AccessControl.AccessControlSections]::Group `
    -bor [System.Security.AccessControl.AccessControlSections]::Access
  $security = [System.IO.FileSystemAclExtensions]::GetAccessControl($Item, $sections)
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($owner.Value -ne $ExpectedSids[0].Value) {
    if (-not $RepairOwner -or $Kind -ne 'file' -or $owner.Value -ne 'S-1-5-32-544') {
      Throw-InvalidAcl '私有路径必须由当前 SID 拥有'
    }
    # Only the explicit repair command can reclaim an administrator-owned file.
    # Require a full-control ACE for this user, rather than relying on elevation
    # or group membership; conservatively reject any deny ACE before mutation.
    $userHasControl = $false
    foreach ($rule in $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
        Throw-InvalidAcl '管理员所有文件含拒绝规则，无法定向修复'
      }
      if ($rule.IdentityReference.Value -eq $ExpectedSids[0].Value -and
          ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
          [System.Security.AccessControl.FileSystemRights]::FullControl) {
        $userHasControl = $true
      }
    }
    if (-not $userHasControl) {
      Throw-InvalidAcl '管理员所有文件缺少当前 SID 完全控制权限，无法定向修复'
    }
    $security.SetOwner($ExpectedSids[0])
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
  if ($Kind -ne 'file' -and (Test-UserOnlyDirectoryAcl $Item $ExpectedSids[0])) {
    $ExpectedSids = @($ExpectedSids[0])
  }
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

function Test-UserOnlyDirectoryAcl($Item, $UserSid) {
  $security = [System.IO.FileSystemAclExtensions]::GetAccessControl($Item,
    [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)
  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1 -or -not $security.AreAccessRulesProtected) { return $false }
  $rule = $rules[0]
  return $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $UserSid.Value `
    -and $rule.IdentityReference.Value -eq $UserSid.Value `
    -and $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow `
    -and $rule.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl `
    -and $rule.InheritanceFlags -eq ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) `
    -and $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None `
    -and -not $rule.IsInherited
}

$request = $null
$aclMutex = $null
$aclMutexHeld = $false
$repairStream = $null
$stage = 'request'
try {
  $request = Get-Request
  if ($request.operation -in @('secure', 'repair')) {
    $stage = 'lock'
    # Serialize detection and mutation across Gateway, service and setup processes.
    $identity = [System.IO.Path]::GetFullPath($request.path).ToUpperInvariant()
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = [System.BitConverter]::ToString($hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '') }
    finally { $hasher.Dispose() }
    $aclMutex = [System.Threading.Mutex]::new($false, ('Local\codexc-private-acl-' + $hash))
    try { $aclMutexHeld = $aclMutex.WaitOne(500) }
    catch [System.Threading.AbandonedMutexException] { $aclMutexHeld = $true }
    if (-not $aclMutexHeld) { Throw-InvalidAcl '私有路径 ACL 正由其他进程更新，请重试' }
  }
  $stage = 'inspect'
  $item = Get-PathItem $request.path $request.kind
  if ($request.operation -eq 'repair') {
    # Keep the inspected file from being replaced while ownership is checked,
    # changed and verified. No configuration content is read from this handle.
    $repairStream = [System.IO.File]::Open($request.path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $item = Get-PathItem $request.path 'file'
  }
  $expectedSids = Get-ExpectedSids
  # Codex 0.160.1 requires exactly one inheritable user ACE on its socket directory.
  # Other writers sharing that directory must preserve this stronger ACL.
  if ($request.kind -ne 'file' -and (Test-UserOnlyDirectoryAcl $item $expectedSids[0])) {
    $expectedSids = @($expectedSids[0])
  }
  if ($request.kind -eq 'socket-directory') {
    if ($request.operation -eq 'secure') {
      # Tighten only an already trusted directory; never take ownership or accept
      # unrelated principals merely because the current process can change its ACL.
      $stage = 'verify'
      Assert-PrivateAcl $item 'directory' $expectedSids
      $stage = 'secure'
      Set-PrivateAcl $item 'directory' @($expectedSids[0])
      $item = Get-PathItem $request.path 'socket-directory'
    }
    $stage = 'verify'
    if (-not (Test-UserOnlyDirectoryAcl $item $expectedSids[0])) {
      Throw-InvalidAcl 'Socket 目录必须仅允许当前 SID 访问'
    }
    @{ ok = $true } | ConvertTo-Json -Compress
    exit 0
  }
  if ($request.operation -eq 'read-config') {
    $stage = 'read-config'
    # Hold the file against writes and atomic replacement while checking both ACLs
    # and reading. Never repair permissions on this read-only path.
    $stream = [System.IO.File]::Open($request.path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
      $item = Get-PathItem $request.path 'file'
      $stage = 'verify-parent'
      $parent = Get-PathItem ([System.IO.Path]::GetDirectoryName($item.FullName)) 'parent-directory'
      Assert-PrivateAcl $parent 'parent-directory' $expectedSids
      $stage = 'read-config'
      Assert-PrivateAcl $item 'file' $expectedSids
      if ($stream.Length -gt 1048576) { Throw-InvalidAcl '私有配置超过读取上限' }
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false, $true))
      try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
      @{ ok = $true; content = $content } | ConvertTo-Json -Compress
    } finally { $stream.Dispose() }
    exit 0
  }
  if ($request.operation -in @('secure', 'repair')) {
    $stage = 'secure'
    Set-PrivateAcl $item $request.kind $expectedSids ($request.operation -eq 'repair')
    $item = Get-PathItem $request.path $request.kind
  }
  $stage = 'verify'
  Assert-PrivateAcl $item $request.kind $expectedSids
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  # Do not return exception messages: PowerShell/.NET may include file contents.
  @{ ok = $false; stage = $stage; reason = $_.Exception.Data['codexcAclReason'] } |
    ConvertTo-Json -Compress
  exit 1
} finally {
  if ($null -ne $repairStream) { $repairStream.Dispose() }
  if ($aclMutexHeld) { $aclMutex.ReleaseMutex() }
  if ($null -ne $aclMutex) { $aclMutex.Dispose() }
}
