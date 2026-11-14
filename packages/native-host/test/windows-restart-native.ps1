param([string]$Library)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RestartFixture {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibrary(string path);
    [DllImport("kernel32.dll", CharSet=CharSet.Ansi)] public static extern IntPtr GetProcAddress(IntPtr library, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int RegisterApplicationRestart(string args, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetApplicationRestartSettings(IntPtr process, StringBuilder args, ref uint size, out uint flags);
    [DllImport("kernel32.dll")] public static extern int UnregisterApplicationRestart();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate int ClearRestart();
}
'@
try {
    if ([RestartFixture]::RegisterApplicationRestart('--codexdc-disposable-test', 0) -ne 0) { throw 'Cannot register test process' }
    $buffer = New-Object System.Text.StringBuilder 1025
    [uint32]$size = 1025
    [uint32]$flags = 0
    $handle = (Get-Process -Id $PID).Handle
    if ([RestartFixture]::GetApplicationRestartSettings($handle, $buffer, [ref]$size, [ref]$flags) -ne 0) { throw 'Test process was not registered' }
    if ($buffer.ToString() -ne '--codexdc-disposable-test') { throw 'Unexpected restart arguments' }
    $module = [RestartFixture]::LoadLibrary($Library)
    if ($module -eq [IntPtr]::Zero) { throw 'Cannot load native restart bridge' }
    $address = [RestartFixture]::GetProcAddress($module, 'codexdc_unregister_restart')
    $clear = [System.Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($address, [RestartFixture+ClearRestart])
    if ($clear.Invoke() -ne 0) { throw 'Native unregister failed' }
    $size = 1025
    if ([RestartFixture]::GetApplicationRestartSettings($handle, $buffer, [ref]$size, [ref]$flags) -ne -2147023728) { throw 'Process is still registered' }
    'Native registration and unregister test passed'
} finally { $null = [RestartFixture]::UnregisterApplicationRestart() }
