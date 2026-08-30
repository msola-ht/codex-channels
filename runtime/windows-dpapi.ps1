$ErrorActionPreference = 'Stop'

$requestText = [Console]::In.ReadToEnd()
$request = $requestText | ConvertFrom-Json -Depth 3
$inputBytes = [Convert]::FromBase64String([string]$request.data)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser

if ($request.operation -eq 'protect') {
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $inputBytes,
        $null,
        $scope
    )
}
elseif ($request.operation -eq 'unprotect') {
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $inputBytes,
        $null,
        $scope
    )
}
else {
    throw '不支持的 DPAPI 操作'
}

[pscustomobject]@{
    ok = $true
    data = [Convert]::ToBase64String($outputBytes)
} | ConvertTo-Json -Compress
