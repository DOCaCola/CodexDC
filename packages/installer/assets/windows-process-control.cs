using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace CodexDC {
    public static class ProcessControl {
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
        [DllImport("advapi32.dll", SetLastError=true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError=true)]
        private static extern bool GetTokenInformation(IntPtr token, int kind, out int elevation, int size, out int returned);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        public static bool? ReadElevation(int processId) {
            IntPtr process = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
            if (process == IntPtr.Zero) return null;
            IntPtr token = IntPtr.Zero;
            try {
                if (!OpenProcessToken(process, 0x0008, out token)) return null; // TOKEN_QUERY
                int elevation, returned;
                if (!GetTokenInformation(token, 20, out elevation, sizeof(int), out returned)) return null; // TokenElevation
                return elevation != 0;
            } finally {
                if (token != IntPtr.Zero) CloseHandle(token);
                CloseHandle(process);
            }
        }

        // Query the verified handle, never reopen a potentially recycled PID.
        public static string OwnerSid(IntPtr process) {
            IntPtr token;
            if (!OpenProcessToken(process, 0x0008, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                using (WindowsIdentity identity = new WindowsIdentity(token)) {
                    return identity.User.Value;
                }
            } finally {
                CloseHandle(token);
            }
        }

        public static void Terminate(IntPtr process) {
            if (!TerminateProcess(process, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
