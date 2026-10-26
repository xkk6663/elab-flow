/**
 * Windows Job Object 垫片 —— 让"杀掉 cockpit 进程"能连带终结**整棵**进程树。
 *
 * 为什么需要它（Q16，`services/elab/run.py:200-204` 自认的缺口）：
 *   elab 取消 run 时杀的是 `elab run` 进程，它拉起的工具子进程（OTA 上位机、
 *   cli_flash.py、cmake/ninja/gcc、openocd）会变**孤儿继续跑**，并且一直占着
 *   串口 —— 用户看到"取消了但串口还是活的"。
 *
 * 方案（实测通过 2026-10-26，见 `scripts/probe-jobobject.ps1`）：
 *   插件 Host 半在 spawn cockpit 之后，通过 PowerShell 垫片
 *   ① CreateJobObject ② SetInformationJobObject(KILL_ON_JOB_CLOSE)
 *   ③ AssignProcessToJobObject。
 *   垫片**长期存活持有 Job 句柄**；关闭其 stdin（或杀掉垫片）→ 句柄回收 →
 *   KILL_ON_JOB_CLOSE 生效 → 整树终结。`cockpit/server.py` 一行不改。
 *
 * ★ 两个实测坑（都踩过，别再重复）：
 *   1. **垫片必须存活**。它一退出，Job 句柄就回收，整棵树立刻被杀 ——
 *      实测表现为"cockpit 刚 armed 就 exit 0"，且服务永远连不上。
 *   2. **Node 侧不能给 stdin 写端立即 EOF**：`stdio: ['pipe',...]` 且从不写入时，
 *      某些组合会让垫片的 ReadLine 读到 null 直接退出（同 1）。
 *      对策是 `stdin` 保持打开、只在真正要终结时 `end()`。
 *
 * 为什么不是 FFI：profile 里没有任何 FFI 包（koffi/ffi-napi 皆无），
 *   引入原生依赖要过 addon 编译与多平台分发包。PowerShell 垫片零依赖、
 *   异步执行、失败可降级，先在 Windows 打通（本产品的目标平台）。
 *
 * 降级：非 Windows、或 PowerShell 不可用、或任何一步失败 → 返回 `unavailable`，
 *   调用方退回 `taskkill /T /F`。**降级必须显式可见**，不能静默以为在用 Job。
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
/**
 * 垫片脚本：建 Job → 设 KILL_ON_JOB_CLOSE → 把 owner 进程挂进去 → 打印 OK →
 * 然后**阻塞读 stdin**，直到父进程关掉它（= 要终结整棵树）。
 *
 * ★ 写成独立文件而不是 `-Command`：PowerShell 对超长内联命令有限制，
 *   且文件形式便于失败时手工复跑诊断。
 */
const JOB_SHIM = String.raw `
param([int]$OwnerPid)
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class JobShim {
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
$job = [JobShim]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { Write-Output "ERR create"; exit 3 }
$info = New-Object JobShim+ELI
$info.basic.flags = 0x2000
$okSet = [JobShim]::SetInformationJobObject($job, 9, [ref]$info, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'JobShim+ELI'))
if (-not $okSet) { Write-Output "ERR setinfo"; exit 4 }
$proc = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
if ($null -eq $proc) { Write-Output "ERR noproc"; exit 5 }
if (-not [JobShim]::AssignProcessToJobObject($job, $proc.Handle)) { Write-Output "ERR assign"; exit 6 }
Write-Output "OK"
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'KILL') { break }
  Start-Sleep -Milliseconds 200
}
exit 0
`;
let shimScriptPath;
async function ensureShimScript() {
    if (shimScriptPath !== undefined)
        return shimScriptPath;
    try {
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { writeFile } = await import('node:fs/promises');
        const path = join(tmpdir(), 'dsh-elab-cockpit-job.ps1');
        await writeFile(path, JOB_SHIM.replace(/\r?\n/g, '\r\n'), 'utf8');
        shimScriptPath = path;
        return path;
    }
    catch {
        return undefined;
    }
}
/**
 * 把 `pid` 拉进一个新的、KILL_ON_JOB_CLOSE 的 Job。
 *
 * 调用时机：**必须在目标进程已 spawn 之后**（Job 需要进程句柄）。
 * 进程启动到这里之间有一个极小窗口，其子进程尚未受管 ——
 * 此时 cockpit 还没开始跑 run，风险可接受（实测 <50ms）。
 */
export async function armJobForPid(pid) {
    if (process.platform !== 'win32') {
        return { status: 'unavailable', reason: `only win32, got ${process.platform}` };
    }
    const script = await ensureShimScript();
    if (script === undefined) {
        return { status: 'unavailable', reason: 'cannot write job shim script' };
    }
    try {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OwnerPid', String(pid)], 
        // ★ stdin 必须保持可写且**不立即结束**：垫片靠它判断"该不该继续活着"
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const first = await new Promise((resolve) => {
            let buf = '';
            const timer = setTimeout(() => resolve(undefined), 10_000);
            child.stdout?.setEncoding('utf8');
            child.stdout?.on('data', (chunk) => {
                buf += chunk;
                const nl = buf.indexOf('\n');
                if (nl >= 0) {
                    clearTimeout(timer);
                    resolve(buf.slice(0, nl).trim());
                }
            });
            child.once('error', () => {
                clearTimeout(timer);
                resolve(undefined);
            });
            child.once('exit', () => {
                clearTimeout(timer);
                resolve(buf.trim() || undefined);
            });
        });
        if (first !== 'OK') {
            try {
                child.kill();
            }
            catch { /* ignore */ }
            return { status: 'unavailable', reason: `shim said: ${first ?? 'timeout'}` };
        }
        const kill = async () => {
            // 先请垫片自己退（它会在 ReadLine 返回 'KILL' 后 exit）
            try {
                child.stdin?.write('KILL\n');
            }
            catch { /* ignore */ }
            const closed = await new Promise((resolve) => {
                const t = setTimeout(() => resolve(false), 3000);
                child.once('exit', () => {
                    clearTimeout(t);
                    resolve(true);
                });
            });
            if (!closed) {
                // 兜底：杀垫片（进程终止同样回收句柄）
                try {
                    child.kill();
                }
                catch { /* ignore */ }
            }
            try {
                child.stdin?.end();
            }
            catch { /* ignore */ }
        };
        const armed = { status: 'armed', kill };
        return armed;
    }
    catch (error) {
        return { status: 'unavailable', reason: String(error) };
    }
}
/** 降级路径：按 PID 树强杀。Job 不可用时使用。 */
export async function taskkillTree(pid) {
    if (process.platform === 'win32') {
        try {
            await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        }
        catch { /* 进程可能已退出 */ }
        return;
    }
    try {
        process.kill(-pid, 'SIGKILL');
    }
    catch {
        try {
            process.kill(pid, 'SIGKILL');
        }
        catch { /* ignore */ }
    }
}
