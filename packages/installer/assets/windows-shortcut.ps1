param(
  [Parameter(Mandatory = $true)]
  [string]$ShortcutPath,

  [Parameter(Mandatory = $true)]
  [string]$TargetPath,

  [Parameter(Mandatory = $true)]
  [string]$WorkingDirectory,

  [string]$IconPath,

  [string]$AppUserModelId
)

$ErrorActionPreference = "Stop"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $TargetPath
$shortcut.WorkingDirectory = $WorkingDirectory
if ($IconPath) {
  $shortcut.IconLocation = "$IconPath,0"
} else {
  $shortcut.IconLocation = "$TargetPath,0"
}
$shortcut.Save()

if ([string]::IsNullOrWhiteSpace($AppUserModelId)) {
  exit 0
}

$source = @'
using System;
using System.Runtime.InteropServices;

namespace CodexPlusPlus {
    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey {
        public Guid FormatId;
        public uint PropertyId;

        public PropertyKey(Guid formatId, uint propertyId) {
            FormatId = formatId;
            PropertyId = propertyId;
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PropVariant {
        [FieldOffset(0)]
        public ushort VariantType;
        [FieldOffset(2)]
        public ushort Reserved1;
        [FieldOffset(4)]
        public ushort Reserved2;
        [FieldOffset(6)]
        public ushort Reserved3;
        [FieldOffset(8)]
        public IntPtr Value;
    }

    [ComImport]
    [Guid("0000010B-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPersistFile {
        int GetClassID(out Guid classId);
        int IsDirty();
        int Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        int Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
        int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        int GetCurFile(out IntPtr fileName);
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        int GetCount(out uint count);
        int GetAt(uint index, out PropertyKey key);
        int GetValue(ref PropertyKey key, out PropVariant value);
        int SetValue(ref PropertyKey key, ref PropVariant value);
        int Commit();
    }

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    public class ShellLink {
    }

    public static class ShortcutProperties {
        private static readonly Guid AppUserModelIdKey =
            new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

        public static void SetAppUserModelId(string shortcutPath, string appUserModelId) {
            var persistFile = (IPersistFile)new ShellLink();
            Check(persistFile.Load(shortcutPath, 2));

            var propertyStore = (IPropertyStore)persistFile;
            var key = new PropertyKey(AppUserModelIdKey, 5);
            var value = new PropVariant {
                VariantType = 31,
                Value = Marshal.StringToCoTaskMemUni(appUserModelId)
            };

            try {
                Check(propertyStore.SetValue(ref key, ref value));
                Check(propertyStore.Commit());
                Check(persistFile.Save(shortcutPath, true));
            } finally {
                Marshal.FreeCoTaskMem(value.Value);
            }
        }

        private static void Check(int result) {
            if (result < 0) {
                Marshal.ThrowExceptionForHR(result);
            }
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  [CodexPlusPlus.ShortcutProperties]::SetAppUserModelId($ShortcutPath, $AppUserModelId)
} catch {
  Write-Warning "Could not set shortcut AppUserModelId: $($_.Exception.Message)"
}
