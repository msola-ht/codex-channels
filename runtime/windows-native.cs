using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CodexcWindows {
    // Hold every ancestor against rename/replacement; never canonicalize through a junction.
    public sealed class DirectoryGuard : IDisposable {
        private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        public DirectoryGuard(string path) {
            try {
                string full = Path.GetFullPath(path);
                string root = Path.GetPathRoot(full);
                if (root == null || root.Length != 3 || root[1] != ':')
                    throw new IOException("Protected paths require a local drive");
                Open(root);
                string current = root;
                foreach (string part in full.Substring(root.Length).Split(new [] {'\\', '/'}, StringSplitOptions.RemoveEmptyEntries)) {
                    current = Path.Combine(current, part);
                    Open(current);
                }
            } catch { Dispose(); throw; }
        }
        private void Open(string path) {
            // Metadata-only opens do not participate in Windows sharing checks.
            // FILE_LIST_DIRECTORY makes omission of FILE_SHARE_DELETE pin the path.
            SafeFileHandle handle = Native.CreateFileW(path, 0x20081, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            handles.Add(handle);
            StringBuilder finalPath = new StringBuilder(32768);
            uint length = Native.GetFinalPathNameByHandleW(handle, finalPath, (uint)finalPath.Capacity, 0);
            if (length == 0 || length >= finalPath.Capacity) throw new IOException("Cannot resolve protected volume");
            string resolved = finalPath.ToString();
            if (!resolved.StartsWith("\\\\?\\", StringComparison.Ordinal) || resolved.Length < 7 || resolved[5] != ':')
                throw new IOException("Protected paths require a local volume");
            uint driveType = Native.GetDriveTypeW(resolved.Substring(4, 3));
            if (driveType != 2 && driveType != 3 && driveType != 5 && driveType != 6)
                throw new IOException("Protected paths require a local volume");
            Native.FileInformation info;
            if (!Native.GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0)
                throw new IOException("Protected path contains a reparse point or non-directory");
        }
        public void Dispose() {
            for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
            handles.Clear();
        }
    }

    public static class OwnedProcess {
        // The job handle belongs to this helper. Even forced helper termination closes it.
        // Assign at creation, matching upstream: no unowned suspended-process window.
        public static int Run(string file, string[] args, bool verbatim, string workingDirectory) {
            IntPtr job = Native.CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            Native.ProcessInformation process = new Native.ProcessInformation();
            IntPtr[] streams = new IntPtr[3];
            IntPtr attributes = IntPtr.Zero;
            IntPtr jobList = IntPtr.Zero;
            bool attributesInitialized = false;
            try {
                Native.JobLimits limits = new Native.JobLimits();
                limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if (!Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Native.JobLimits>()))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                for (int i = 0; i < 3; i++) {
                    IntPtr source = Native.GetStdHandle(-10 - i);
                    SafeFileHandle nullStream = null;
                    try {
                        // Scheduled tasks may have no console or redirected standard handles.
                        if (source == IntPtr.Zero || source == new IntPtr(-1)) {
                            nullStream = Native.CreateFileW("NUL", i == 0 ? 0x80000000u : 0x40000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
                            if (nullStream.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                            source = nullStream.DangerousGetHandle();
                        }
                        if (!Native.DuplicateHandle(Native.GetCurrentProcess(), source, Native.GetCurrentProcess(), out streams[i], 0, true, 2))
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                    } finally { if (nullStream != null) nullStream.Dispose(); }
                }
                UIntPtr bytes = UIntPtr.Zero;
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
                if (bytes == UIntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                attributes = Marshal.AllocHGlobal(checked((int)bytes.ToUInt64()));
                if (!Native.InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                attributesInitialized = true;
                jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList, job);
                if (!Native.UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x2000D), jobList,
                    new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                Native.StartupInfoEx startup = new Native.StartupInfoEx();
                startup.Info.Size = (uint)Marshal.SizeOf<Native.StartupInfoEx>();
                startup.Info.Flags = 0x100;
                startup.Info.Input = streams[0]; startup.Info.Output = streams[1]; startup.Info.Error = streams[2];
                startup.Attributes = attributes;
                StringBuilder command = new StringBuilder(Quote(file));
                foreach (string arg in args) command.Append(' ').Append(verbatim ? arg : Quote(arg));
                if (!Native.CreateProcessW(file, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004,
                    IntPtr.Zero, workingDirectory, ref startup, out process))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (Native.ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (Native.WaitForSingleObject(process.Process, uint.MaxValue) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint exitCode;
                if (!Native.GetExitCodeProcess(process.Process, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
                // A root can exit while descendants remain. End and await the entire job.
                if (!Native.TerminateJobObject(job, exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
                for (int attempt = 0; attempt < 500; attempt++) {
                    Native.JobAccounting accounting;
                    if (!Native.QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf<Native.JobAccounting>(), IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (accounting.ActiveProcesses == 0) return unchecked((int)exitCode);
                    System.Threading.Thread.Sleep(10);
                }
                throw new IOException("Owned process job did not become empty");
            } finally {
                Native.CloseHandle(job);
                if (attributesInitialized) Native.DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (process.Thread != IntPtr.Zero) Native.CloseHandle(process.Thread);
                if (process.Process != IntPtr.Zero) Native.CloseHandle(process.Process);
                foreach (IntPtr stream in streams) if (stream != IntPtr.Zero) Native.CloseHandle(stream);
            }
        }
        private static string Quote(string value) {
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
                else result.Append('\\', slashes).Append(c);
                slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
    }

    internal static class Native {
        [StructLayout(LayoutKind.Sequential)] internal struct FileInformation {
            internal uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh,
                Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct BasicLimits {
            internal long ProcessTime, JobTime;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct IoCounters {
            internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct JobLimits {
            internal BasicLimits Basic;
            internal IoCounters Io;
            internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct JobAccounting {
            internal long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
            internal uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct StartupInfo {
            internal uint Size;
            internal string Reserved, Desktop, Title;
            internal uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
            internal ushort Show, ReservedSize;
            internal IntPtr ReservedPointer, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct ProcessInformation {
            internal IntPtr Process, Thread;
            internal uint ProcessId, ThreadId;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct StartupInfoEx {
            internal StartupInfo Info;
            internal IntPtr Attributes;
        }
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, uint count, uint flags, ref UIntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedSize);
        [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern uint GetDriveTypeW(string root);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObjectW(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool QueryInformationJobObject(IntPtr job, int kind, out JobAccounting info, uint length, IntPtr returnedLength);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcessW(string file, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr GetStdHandle(int kind);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    }
}
