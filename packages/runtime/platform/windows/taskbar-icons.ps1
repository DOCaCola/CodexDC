param(
  [Parameter(Mandatory = $true)][string]$IconPath,
  [Parameter(Mandatory = $true)][string]$AppUserModelId,
  [Parameter(Mandatory = $true)][int]$OwnerProcessId,
  [AllowEmptyString()][string]$WindowHandles,
  [Parameter(Mandatory = $true)][string]$RelaunchCommandBase64
)
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
namespace CodexDC {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey {
    public Guid FormatId;
    public uint PropertyId;
    public PropertyKey(uint id) { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); PropertyId = id; }
  }
  [StructLayout(LayoutKind.Explicit, Size=24)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public IntPtr Value;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }
  public static class Taskbar {
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out IPropertyStore store);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(uint change, uint flags, string item, IntPtr other);
    static void Set(IPropertyStore store, uint id, string text) {
      var key = new PropertyKey(id);
      var value = new PropVariant { Type = 31, Value = Marshal.StringToCoTaskMemUni(text) };
      try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value)); }
      finally { Marshal.FreeCoTaskMem(value.Value); }
    }
    public static int UpdateWindows(uint processId, long[] handles, string appId, string icon, string command) {
      int count = 0;
      foreach (long handle in handles) {
        var window = new IntPtr(handle);
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (!IsWindow(window)) continue;
        if (owner != processId) throw new InvalidOperationException("Window does not belong to Codex-DC.");
        var iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window, ref iid, out store));
        try {
          Set(store, 2, command);
          Set(store, 3, icon + ",0");
          Set(store, 4, "Codex-DC");
          Set(store, 5, appId);
          Marshal.ThrowExceptionForHR(store.Commit());
        } finally { Marshal.ReleaseComObject(store); }
        count++;
      }
      return count;
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RelaunchCommandBase64))
$handles = @($WindowHandles.Split(',', [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { [long]$_ })
$windows = [CodexDC.Taskbar]::UpdateWindows($OwnerProcessId, [long[]]$handles, $AppUserModelId, $IconPath, $command)
$desktop = [Environment]::GetFolderPath('Desktop')
$appData = [Environment]::GetFolderPath('ApplicationData')
$paths = @((Join-Path $desktop 'CodexDC.lnk'), (Join-Path $appData 'Microsoft\Windows\Start Menu\Programs\CodexDC.lnk'))
$pinned = Join-Path $appData 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
if (Test-Path -LiteralPath $pinned) { $paths += @(Get-ChildItem -LiteralPath $pinned -Filter '*.lnk' | ForEach-Object FullName) }
$explorer = New-Object -ComObject Shell.Application
$wsh = New-Object -ComObject WScript.Shell
$updated = @()
foreach ($path in $paths) {
  if (!(Test-Path -LiteralPath $path)) { continue }
  $item = $explorer.Namespace((Split-Path $path)).ParseName((Split-Path $path -Leaf))
  if ($item.ExtendedProperty('System.AppUserModel.ID') -ne $AppUserModelId) { continue }
  $link = $wsh.CreateShortcut($path)
  if ($link.IconLocation -eq "$IconPath,0") { continue }
  $link.IconLocation = "$IconPath,0"
  $link.Save()
  [CodexDC.Taskbar]::SHChangeNotify(0x2000, 0x1005, $path, [IntPtr]::Zero)
  $updated += $path
}
@{ windows = $windows; shortcuts = $updated; icon = $IconPath } | ConvertTo-Json -Compress
