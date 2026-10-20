using System;
using System.ComponentModel;
using System.Reflection;
using System.Runtime.InteropServices;
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

    private static int Main(string[] args)
    {
        if (args.Length != 0) { Console.Error.WriteLine("Web Stop adapter entry refused unexpected arguments."); return 64; }
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero;
        ProcessInformation child = new ProcessInformation();
        bool attributeListReady = false, childFinished = false;
        try
        {
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
            StringBuilder command = new StringBuilder("\"" + Node + "\" \"" + Adapter + "\" --config \"" + Config + "\"");
            // A null environment inherits it verbatim, without reading or copying values.
            // Start suspended so no descendant can escape the owned job before assignment.
            Require(CreateProcess(Node, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref startup, out child));
            Require(AssignProcessToJobObject(job, child.process));
            if (ResumeThread(child.thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            Close(ref child.thread);
            Close(ref input); Close(ref output); Close(ref error);
            if (WaitForSingleObject(child.process, uint.MaxValue) != 0) throw new InvalidOperationException();
            childFinished = true;
            uint exitCode;
            Require(GetExitCodeProcess(child.process, out exitCode));
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
            Close(ref input); Close(ref output); Close(ref error);
            if (attributeListReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
    }
}
