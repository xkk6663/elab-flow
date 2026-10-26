param([int]$OwnerPid)
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class J2 {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [StructLayout(LayoutKind.Sequential)]
    public struct BLI { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
    [StructLayout(LayoutKind.Sequential)]
    public struct IOC { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)]
    public struct ELI { public BLI basic; public IOC io; public UIntPtr a,b,c,d; }
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(IntPtr j, int cls, ref ELI info, uint len);
}
'@
Add-Type -TypeDefinition $sig
$job = [J2]::CreateJobObject([IntPtr]::Zero, $null)
$info = New-Object J2+ELI
$info.basic.flags = 0x2000
$ok = [J2]::SetInformationJobObject($job, 9, [ref]$info, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'J2+ELI'))
Write-Output "setinfo=$ok err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
$p = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
if ($null -eq $p) { Write-Output "ERR noproc"; exit 5 }
$as = [J2]::AssignProcessToJobObject($job, $p.Handle)
Write-Output "assign=$as err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
Write-Output "OK"
Start-Sleep -Seconds 5
Write-Output "shim done"
