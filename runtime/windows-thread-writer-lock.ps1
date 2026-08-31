$ErrorActionPreference = 'Stop'

$requestText = [Console]::In.ReadToEnd()
$request = $requestText | ConvertFrom-Json -Depth 4

if ($request.operation -eq 'terminate') {
    $pidValue = [int]$request.pid
    $expectedStartedAt = [string]$request.startedAt
    $timeoutMs = [int]$request.timeoutMs
    try {
        $target = [System.Diagnostics.Process]::GetProcessById($pidValue)
    }
    catch [System.ArgumentException] {
        [pscustomobject]@{ ok = $true; exited = $true } | ConvertTo-Json -Compress
        exit 0
    }
    $actualStartedAt = $target.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
    if ($actualStartedAt -ne $expectedStartedAt) {
        [pscustomobject]@{ ok = $true; exited = $false } | ConvertTo-Json -Compress
        exit 0
    }
    $target.Kill()
    [pscustomobject]@{
        ok = $true
        exited = $target.WaitForExit($timeoutMs)
    } | ConvertTo-Json -Compress
    exit 0
}

if ($request.operation -ne 'inspect') {
    throw '不支持的 Windows Thread Writer Lock 操作'
}

$lockPath = [System.IO.Path]::GetFullPath([string]$request.path)
if (-not [System.IO.File]::Exists($lockPath)) {
    [pscustomobject]@{ ok = $true; holders = @() } | ConvertTo-Json -Compress -Depth 4
    exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CodexRestartManager
{
    private const int ErrorSuccess = 0;
    private const int ErrorMoreData = 234;

    [StructLayout(LayoutKind.Sequential)]
    private struct RmUniqueProcess
    {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RmProcessInfo
    {
        public RmUniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string ServiceShortName;
        public uint ApplicationType;
        public uint AppStatus;
        public uint TerminalSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool Restartable;
    }

    public sealed class Holder
    {
        public int Pid { get; set; }
        public ulong StartedAt { get; set; }
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(
        out uint sessionHandle,
        int sessionFlags,
        StringBuilder sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(
        uint sessionHandle,
        uint fileCount,
        string[] fileNames,
        uint applicationCount,
        RmUniqueProcess[] applications,
        uint serviceCount,
        string[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(
        uint sessionHandle,
        out uint processInfoNeeded,
        ref uint processInfoCount,
        [In, Out] RmProcessInfo[] affectedApplications,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint sessionHandle);

    public static Holder[] GetLockingProcesses(string path)
    {
        uint sessionHandle;
        var sessionKey = new StringBuilder(33);
        var result = RmStartSession(out sessionHandle, 0, sessionKey);
        if (result != ErrorSuccess) throw new InvalidOperationException("RmStartSession: " + result);
        try
        {
            result = RmRegisterResources(
                sessionHandle,
                1,
                new[] { path },
                0,
                null,
                0,
                null);
            if (result != ErrorSuccess) throw new InvalidOperationException("RmRegisterResources: " + result);

            uint needed;
            uint count = 0;
            uint rebootReasons = 0;
            result = RmGetList(sessionHandle, out needed, ref count, null, ref rebootReasons);
            if (result == ErrorSuccess) return Array.Empty<Holder>();
            if (result != ErrorMoreData) throw new InvalidOperationException("RmGetList(size): " + result);

            var processes = new RmProcessInfo[needed];
            count = needed;
            result = RmGetList(sessionHandle, out needed, ref count, processes, ref rebootReasons);
            if (result != ErrorSuccess) throw new InvalidOperationException("RmGetList(data): " + result);

            var holders = new List<Holder>();
            for (var index = 0; index < count; index++)
            {
                var time = processes[index].Process.ProcessStartTime;
                holders.Add(new Holder
                {
                    Pid = processes[index].Process.ProcessId,
                    StartedAt = ((ulong)(uint)time.dwHighDateTime << 32) | (uint)time.dwLowDateTime,
                });
            }
            return holders.ToArray();
        }
        finally
        {
            RmEndSession(sessionHandle);
        }
    }
}
'@

$holders = @()
foreach ($holder in [CodexRestartManager]::GetLockingProcesses($lockPath)) {
    $executable = ''
    try {
        $target = [System.Diagnostics.Process]::GetProcessById($holder.Pid)
        if ($target.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -eq $holder.StartedAt.ToString()) {
            $executable = $target.MainModule.FileName
        }
    }
    catch {
        $executable = ''
    }
    $holders += [pscustomobject]@{
        pid = $holder.Pid
        startedAt = $holder.StartedAt.ToString()
        executable = $executable
    }
}

[pscustomobject]@{ ok = $true; holders = $holders } |
    ConvertTo-Json -Compress -Depth 4
