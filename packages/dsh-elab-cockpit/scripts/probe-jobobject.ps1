# 验证：PowerShell 能否创建 Job Object 并把一个进程塞进去、关 Job 时全树被杀。
# 这是 Job Object 方案的可行性验证（Node 侧无 FFI 时的垫片路线）。
$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class JobObj {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    public static bool KillOnClose(IntPtr hJob) {
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        return SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, ref info,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    }
}
'@

Add-Type -TypeDefinition $sig

$job = [JobObj]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { Write-Output "FAIL: CreateJobObject"; exit 1 }
Write-Output "OK: CreateJobObject => $job"
$killOnClose = [JobObj]::KillOnClose($job)
Write-Output "SetInformationJobObject(KILL_ON_JOB_CLOSE) => $killOnClose (err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"

# 起一个父子链：cmd -> python 子进程（模拟 cockpit -> cmake -> ninja 树）
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = '/c python -c "import time,os;print(\"child pid\",os.getpid(),flush=True);time.sleep(30)"'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
Write-Output "spawned cmd pid=$($p.Id)"

$assigned = [JobObj]::AssignProcessToJobObject($job, $p.Handle)
Write-Output "AssignProcessToJobObject => $assigned (err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"

Start-Sleep -Milliseconds 800
$kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" -ErrorAction SilentlyContinue
Write-Output "children of cmd: $(($kids | ForEach-Object { $_.ProcessId }) -join ',')"

Write-Output "closing job handle (应导致整树结束)..."
[JobObj]::CloseHandle($job) | Out-Null
Start-Sleep -Seconds 2

$alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
Write-Output "cmd alive after close: $([bool]$alive)"
foreach ($k in $kids) {
  $k2 = Get-Process -Id $k.ProcessId -ErrorAction SilentlyContinue
  Write-Output "child $($k.ProcessId) alive: $([bool]$k2)"
}
