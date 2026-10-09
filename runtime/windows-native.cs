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
                OpenRoot(root);
                foreach (string part in full.Substring(root.Length).Split(new [] {'\\', '/'}, StringSplitOptions.RemoveEmptyEntries)) {
                    SafeFileHandle child = OpenRelative(handles[handles.Count - 1], part, 0x20081, 1, 1);
                    handles.Add(child);
                    Validate(child);
                }
            } catch { Dispose(); throw; }
        }
        private void OpenRoot(string path) {
            // Metadata-only opens do not participate in Windows sharing checks.
            // FILE_LIST_DIRECTORY makes omission of FILE_SHARE_DELETE pin the path.
            SafeFileHandle handle = Native.CreateFileW(path, 0x20081, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            handles.Add(handle);
            Validate(handle);
        }
        private static void Validate(SafeFileHandle handle) {
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
        // Only socket owners call this after their ACL checks. Read-only ACL checks
        // retain directory pins without creating files in the inspected directory.
        public void ProtectContents() {
            if (handles.Count == 0) throw new ObjectDisposedException("DirectoryGuard");
            SafeFileHandle directory = handles[handles.Count - 1];
            SafeFileHandle guard = OpenRelative(directory, ".codexc-socket-" + Guid.NewGuid().ToString("N") + ".guard",
                0x10001, 2, 0x1040); // FILE_READ_DATA | DELETE; CREATE; NON_DIRECTORY | DELETE_ON_CLOSE
            handles.Add(guard);
            // Conversion could have raced guard installation. Reject it before use.
            Validate(directory);
        }
        private static SafeFileHandle OpenRelative(SafeFileHandle directory, string name, uint access, uint disposition, uint options) {
            if (name.Length == 0 || name.IndexOfAny(new [] {'\\', '/', ':', '\0'}) >= 0 || name == "." || name == "..")
                throw new IOException("Invalid protected path component");
            IntPtr text = Marshal.StringToHGlobalUni(name);
            IntPtr unicode = IntPtr.Zero;
            try {
                Native.UnicodeString value = new Native.UnicodeString();
                value.Length = checked((ushort)(name.Length * 2));
                value.MaximumLength = checked((ushort)(value.Length + 2));
                value.Buffer = text;
                unicode = Marshal.AllocHGlobal(Marshal.SizeOf<Native.UnicodeString>());
                Marshal.StructureToPtr(value, unicode, false);
                Native.ObjectAttributes attributes = new Native.ObjectAttributes();
                attributes.Length = (uint)Marshal.SizeOf<Native.ObjectAttributes>();
                attributes.RootDirectory = directory.DangerousGetHandle();
                attributes.Name = unicode;
                attributes.Attributes = 0x1040; // OBJ_DONT_REPARSE | OBJ_CASE_INSENSITIVE
                Native.IoStatusBlock io;
                IntPtr opened;
                int status = Native.NtCreateFile(out opened, access, ref attributes, out io, IntPtr.Zero,
                    0x80, 3, disposition, options, IntPtr.Zero, 0);
                if (status < 0) throw new Win32Exception((int)Native.RtlNtStatusToDosError(status));
                return new SafeFileHandle(opened, true);
            } finally {
                if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
                Marshal.FreeHGlobal(text);
            }
        }
        public void Dispose() {
            for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
            handles.Clear();
        }
    }

    // Capture the actual creator once. A retained kernel handle never follows PID reuse.
    public sealed class ProcessOwner : IDisposable {
        internal IntPtr Handle { get; private set; }
        public ProcessOwner(uint processId) {
            Native.ProcessBasicInformation basic;
            int status = Native.NtQueryInformationProcess(Native.GetCurrentProcess(), 0, out basic,
                (uint)Marshal.SizeOf<Native.ProcessBasicInformation>(), IntPtr.Zero);
            if (status < 0) throw new Win32Exception((int)Native.RtlNtStatusToDosError(status));
            if (processId == 0 || basic.ParentProcessId.ToInt64() != processId)
                throw new IOException("Owned process creator does not match");
            Handle = Native.OpenProcess(0x101000, false, processId); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
            if (Handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                long parentCreated, helperCreated, exited, kernel, user;
                if (!Native.GetProcessTimes(Handle, out parentCreated, out exited, out kernel, out user) ||
                    !Native.GetProcessTimes(Native.GetCurrentProcess(), out helperCreated, out exited, out kernel, out user))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                // A recycled creator PID would identify a process born after this helper.
                if (parentCreated > helperCreated) throw new IOException("Owned process creator was replaced");
                EnsureAlive();
            } catch { Dispose(); throw; }
        }
        internal void EnsureAlive() {
            uint result = Native.WaitForSingleObject(Handle, 0);
            if (result == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (result != 258) throw new IOException("Owned process creator has exited");
        }
        public void Dispose() {
            if (Handle != IntPtr.Zero) Native.CloseHandle(Handle);
            Handle = IntPtr.Zero;
        }
    }

    public static class OwnedProcess {
        // The job handle belongs to this helper. Even forced helper termination closes it.
        // Assign at creation, matching upstream: no unowned suspended-process window.
        public static int Run(string file, string[] args, bool verbatim, string workingDirectory) {
            // The scheduled-task launcher itself owns its outer Job.
            return Run(file, args, verbatim, workingDirectory, null);
        }
        public static int Run(string file, string[] args, bool verbatim, string workingDirectory, ProcessOwner owner) {
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
                if (owner != null) owner.EnsureAlive();
                if (!Native.CreateProcessW(file, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004,
                    IntPtr.Zero, workingDirectory, ref startup, out process))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (Native.ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint completed = owner == null ? Native.WaitForSingleObject(process.Process, uint.MaxValue) :
                    Native.WaitForMultipleObjects(2, new [] {owner.Handle, process.Process}, false, uint.MaxValue);
                if (completed == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint exitCode = 1;
                if (owner == null || completed == 1) {
                    if (completed != (owner == null ? 0u : 1u)) throw new IOException("Invalid owned process wait result");
                    if (!Native.GetExitCodeProcess(process.Process, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
                } else if (completed != 0) throw new IOException("Invalid owned process wait result");
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
        [StructLayout(LayoutKind.Sequential)] internal struct UnicodeString {
            internal ushort Length, MaximumLength;
            internal IntPtr Buffer;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct ObjectAttributes {
            internal uint Length;
            internal IntPtr RootDirectory, Name;
            internal uint Attributes;
            internal IntPtr Security, QualityOfService;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct IoStatusBlock {
            internal IntPtr Status;
            internal UIntPtr Information;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct ProcessBasicInformation {
            internal IntPtr Reserved, Peb, Reserved2, Reserved3, ProcessId, ParentProcessId;
        }
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
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("ntdll.dll")] internal static extern int NtQueryInformationProcess(IntPtr process, int kind, out ProcessBasicInformation info, uint length, IntPtr returnedLength);
        [DllImport("ntdll.dll")] internal static extern uint RtlNtStatusToDosError(int status);
        [DllImport("ntdll.dll")] internal static extern int NtCreateFile(out IntPtr handle, uint access,
            ref ObjectAttributes attributes, out IoStatusBlock io, IntPtr allocation, uint fileAttributes,
            uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr GetStdHandle(int kind);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    }
}
