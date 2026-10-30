using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

[assembly: AssemblyTitle("Codex Router Web Stop adapter entry")]
[assembly: AssemblyProduct("Codex Router custom Web Stop adapter")]
[assembly: AssemblyDescription("Custom unsigned fixed-command launcher for an unchanged official Node REPL child.")]

// Custom unsigned fixed-command entry for the Router-owned Web Stop adapter.
// The signed official Node REPL child is unchanged; this entry has a distinct identity.
internal static class WebStopAdapterEntry
{
    private const string Node = @"@@NODE@@";
    private const string Adapter = @"@@ADAPTER@@";
    private const string Config = @"@@CONFIG@@";
    private const string Events = @"@@EVENTS@@";
    private const string OfficialRepl = @"@@OFFICIAL_REPL@@";
    private const string OfficialReplSha256 = "@@OFFICIAL_REPL_SHA256@@";
    private const string NodeSha256 = "@@NODE_SHA256@@";
    private const string CuaEntry = @"@@CUA_ENTRY@@";
    private const string CuaEntrySha256 = "@@CUA_ENTRY_SHA256@@";
    private const string CuaGuard = @"@@CUA_GUARD@@";
    private const string CuaGuardSha256 = "@@CUA_GUARD_SHA256@@";
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int cb;
        public IntPtr reserved, desktop, title;
        public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2Size;
        public IntPtr reserved2, input, output, error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint low, high; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint attributes;
        public FileTime creation, access, write;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long perProcessTime, perJobTime;
        public uint flags;
        public UIntPtr minimumWorkingSet, maximumWorkingSet;
        public uint activeProcessLimit;
        public UIntPtr affinity;
        public uint priorityClass, schedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation basic;
        public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint attributes, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(IntPtr file, out FileInformation information);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(IntPtr file, byte[] bytes, uint size, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimitInformation information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void Require(bool passed) { if (!passed) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    private static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero && handle != InvalidHandle) CloseHandle(handle); handle = IntPtr.Zero; }
    private static IntPtr DuplicateStandardHandle(int kind)
    {
        IntPtr source = GetStdHandle(kind), target;
        if (source == IntPtr.Zero || source == InvalidHandle) throw new InvalidOperationException();
        Require(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out target, 0, true, 2));
        return target;
    }

    private static string FullPath(string value) { return Path.GetFullPath(value); }
    private static bool SamePath(string left, string right)
    {
        return String.Equals(FullPath(left), FullPath(right), StringComparison.OrdinalIgnoreCase);
    }
    private static string Sha256(byte[] value)
    {
        using (SHA256 algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(value)).Replace("-", "").ToLowerInvariant();
    }
    private static string ImageHash(string image) { return Sha256(Encoding.UTF8.GetBytes(FullPath(image).ToLowerInvariant())); }
    private static long StartedTicks(IntPtr process)
    {
        FileTime creation, exit, kernel, user;
        Require(GetProcessTimes(process, out creation, out exit, out kernel, out user));
        long fileTime = ((long)creation.high << 32) | creation.low;
        return checked(fileTime + 504911232000000000L); // Windows FILETIME to UTC .NET ticks.
    }
    private static FileStream VerifiedFile(string file, string expected)
    {
        FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            StringBuilder final = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(stream.SafeFileHandle.DangerousGetHandle(), final, (uint)final.Capacity, 0);
            if (length == 0 || length >= final.Capacity) throw new InvalidOperationException();
            string actualPath = final.ToString();
            if (actualPath.StartsWith(@"\\?\", StringComparison.Ordinal)) actualPath = actualPath.Substring(4);
            if (!SamePath(actualPath, file)) throw new InvalidOperationException();
            using (SHA256 algorithm = SHA256.Create())
            {
                string actual = BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (!String.Equals(actual, expected, StringComparison.Ordinal)) throw new InvalidOperationException();
            }
            return stream;
        }
        catch { stream.Dispose(); throw; }
    }
    private static bool KnownCuaBootstrap()
    {
        // This changes only the process path, never tool or Stop authority. Unknown
        // launchers and custom banners retain the complete Web bridge.
        try
        {
            string selected = Environment.GetEnvironmentVariable("CUA_REPL_NODE_REPL_PATH");
            string banner = Environment.GetEnvironmentVariable("NODE_REPL_JS_BANNER");
            string surfaces = Environment.GetEnvironmentVariable("CUA_REPL_ENABLED_SURFACES");
            if (CuaEntry.Length == 0 || selected == null || !SamePath(selected, Assembly.GetExecutingAssembly().Location)
                || banner == null || banner.Trim() != "await import(\"@oai/cua/tinyskyAlt\");" || String.IsNullOrEmpty(surfaces)) return false;
            bool browser = false, computer = false;
            foreach (string surface in surfaces.Split(','))
            {
                if (surface == "browser" && !browser) browser = true;
                else if (surface == "computer" && !computer) computer = true;
                else return false;
            }
            uint parentId = 0;
            using (ManagementObjectSearcher search = new ManagementObjectSearcher("SELECT ParentProcessId FROM Win32_Process WHERE ProcessId=" + GetCurrentProcessId()))
            {
                search.Options.Timeout = TimeSpan.FromSeconds(2);
                using (ManagementObjectCollection rows = search.Get())
                    foreach (ManagementObject row in rows) using (row) { if (parentId != 0) return false; parentId = (uint)row["ParentProcessId"]; }
            }
            if (parentId == 0) return false;
            IntPtr parent = OpenProcess(0x1000, false, parentId); // PROCESS_QUERY_LIMITED_INFORMATION.
            if (parent == IntPtr.Zero) return false;
            try
            {
                StringBuilder image = new StringBuilder(32768); uint size = (uint)image.Capacity;
                if (!QueryFullProcessImageName(parent, 0, image, ref size) || !SamePath(image.ToString(), Node)
                    || StartedTicks(parent) > StartedTicks(GetCurrentProcess())) return false;
                using (VerifiedFile(Node, NodeSha256))
                using (VerifiedFile(CuaEntry, CuaEntrySha256))
                {
                    string command = null;
                    using (ManagementObjectSearcher search = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + parentId))
                    {
                        search.Options.Timeout = TimeSpan.FromSeconds(2);
                        using (ManagementObjectCollection rows = search.Get())
                            foreach (ManagementObject row in rows) using (row) { if (command != null) return false; command = row["CommandLine"] as string; }
                    }
                    if (command == null || command.Length > 32768) return false;
                    int count; IntPtr parsed = CommandLineToArgvW(command, out count);
                    if (parsed == IntPtr.Zero) return false;
                    try
                    {
                        string[] args = new string[count];
                        for (int index = 0; index < count; index++) args[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(parsed, index * IntPtr.Size));
                        if (count != 2 && count != 4 || !SamePath(args[0], Node) || !SamePath(args[count - 1], CuaEntry)) return false;
                        if (count == 2) return true;
                        if (CuaGuard.Length == 0 || args[1] != "--import" || args[2] != new Uri(CuaGuard).AbsoluteUri) return false;
                        using (VerifiedFile(CuaGuard, CuaGuardSha256)) return true;
                    }
                    finally { LocalFree(parsed); }
                }
            }
            finally { Close(ref parent); }
        }
        catch { return false; } // Unavailable parent evidence conservatively retains the bridge.
    }
    private static void ProcessReceipt(string code, string generation, uint entryPid, long entryTicks, ProcessInformation child, long childTicks, string image, string mode, uint? exitCode)
    {
        // A single append-only native write keeps concurrent launch receipts whole.
        // Failure to observe is not permission to change the child's protocol.
        IntPtr file = InvalidHandle;
        try
        {
            file = CreateFile(Events, 4, 3, IntPtr.Zero, 3, 0x00200080, IntPtr.Zero); // FILE_APPEND_DATA, OPEN_EXISTING, OPEN_REPARSE_POINT.
            if (file == InvalidHandle) return;
            FileInformation information;
            if (!GetFileInformationByHandle(file, out information) || (information.attributes & 0x410) != 0) return;
            string value = "{\"at\":\"" + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + "\",\"code\":\"" + code
                + "\",\"schemaVersion\":1,\"generation\":\"" + generation + "\",\"entryPid\":" + entryPid
                + ",\"entryStartedTicks\":\"" + entryTicks.ToString(CultureInfo.InvariantCulture) + "\",\"pid\":" + child.processId
                + ",\"startedTicks\":\"" + childTicks.ToString(CultureInfo.InvariantCulture) + "\",\"mode\":\"" + mode
                + "\",\"entryImageSha256\":\"" + ImageHash(Assembly.GetExecutingAssembly().Location) + "\",\"imageSha256\":\"" + ImageHash(image)
                + "\"" + (exitCode.HasValue ? ",\"exitCode\":" + exitCode.Value.ToString(CultureInfo.InvariantCulture) : "") + "}\n";
            byte[] record = Encoding.UTF8.GetBytes(value); uint written;
            WriteFile(file, record, (uint)record.Length, out written, IntPtr.Zero);
        }
        catch { }
        finally { Close(ref file); }
    }

    private static int Main(string[] args)
    {
        if (args.Length != 0) { Console.Error.WriteLine("Web Stop adapter entry refused unexpected arguments."); return 64; }
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero;
        ProcessInformation child = new ProcessInformation();
        bool attributeListReady = false, childFinished = false;
        FileStream directIdentity = null;
        string generation = Guid.NewGuid().ToString("D"), mode = "bridge", imagePath = Node;
        uint entryPid = GetCurrentProcessId(); long entryTicks = 0, childTicks = 0;
        try
        {
            entryTicks = StartedTicks(GetCurrentProcess());
            if (KnownCuaBootstrap())
            {
                // The bypass never reaches JavaScript readConfig; validate the
                // unchanged official executable here and hold its bytes at launch.
                directIdentity = VerifiedFile(OfficialRepl, OfficialReplSha256);
                mode = "cua-direct"; imagePath = OfficialRepl;
            }
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            ExtendedLimitInformation limits = new ExtendedLimitInformation();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))));
            input = DuplicateStandardHandle(-10);
            output = DuplicateStandardHandle(-11);
            error = DuplicateStandardHandle(-12);
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            if (bytes == IntPtr.Zero) throw new InvalidOperationException();
            attributes = Marshal.AllocHGlobal(bytes);
            Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes));
            attributeListReady = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input);
            Marshal.WriteIntPtr(handles, IntPtr.Size, output);
            Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            StartupInfoEx startup = new StartupInfoEx();
            startup.startup.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.startup.flags = 0x100; // STARTF_USESTDHANDLES.
            startup.startup.input = input;
            startup.startup.output = output;
            startup.startup.error = error;
            startup.attributes = attributes;
            StringBuilder command = new StringBuilder(mode == "cua-direct" ? "\"" + OfficialRepl + "\""
                : "\"" + Node + "\" \"" + Adapter + "\" --config \"" + Config + "\" --generation " + generation);
            // A null environment inherits it verbatim, without reading or copying values.
            // Start suspended so no descendant can escape the owned job before assignment.
            Require(CreateProcess(imagePath, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref startup, out child));
            Require(AssignProcessToJobObject(job, child.process));
            childTicks = StartedTicks(child.process);
            ProcessReceipt("adapter_process_started", generation, entryPid, entryTicks, child, childTicks, imagePath, mode, null);
            if (ResumeThread(child.thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            Close(ref child.thread);
            Close(ref input); Close(ref output); Close(ref error);
            if (WaitForSingleObject(child.process, uint.MaxValue) != 0) throw new InvalidOperationException();
            childFinished = true;
            uint exitCode;
            Require(GetExitCodeProcess(child.process, out exitCode));
            ProcessReceipt("adapter_process_exited", generation, entryPid, entryTicks, child, childTicks, imagePath, mode, exitCode);
            return unchecked((int)exitCode);
        }
        catch (Exception exception)
        {
            // Bounded diagnostics contain only an OS error number; never env or payloads.
            Win32Exception native = exception as Win32Exception;
            Console.Error.WriteLine("Web Stop adapter entry failed" + (native == null ? "." : " (OS " + native.NativeErrorCode + ")."));
            return 70;
        }
        finally
        {
            if (child.process != IntPtr.Zero && !childFinished) { TerminateProcess(child.process, 70); WaitForSingleObject(child.process, 2000); }
            Close(ref job); // Own descendants are cleaned on success, failure, or process exit.
            Close(ref child.thread); Close(ref child.process);
            if (directIdentity != null) directIdentity.Dispose();
            Close(ref input); Close(ref output); Close(ref error);
            if (attributeListReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
    }
}
