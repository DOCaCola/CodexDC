# @codexdc/native-host

macOS Objective-C++ N-API host used by the CodexDC Owl bridge.

The host is intentionally small:

- `getCapabilities()` reports AppKit/Metal support.
- `createPanel(options)` creates a child `NSPanel` overlay parented to the
  current Codex `BrowserWindow` native handle.
- `attachView(options)` creates a child overlay containing an `MTKView`.
- `disposeAll()` tears down all native windows created by the host.

Direct child `NSView` insertion is not the default path yet. The first 1.0.0
implementation uses a child-window overlay because it is safer against Owl and
Chromium view hierarchy changes.

## Windows application restart

Windows builds also produce `codexdc_windows_restart.node`. The managed desktop
loads it in process to call `UnregisterApplicationRestart` and inspect the result.
Node APIs come from `chrome.dll` in Owl and the executable in Node. The runtime
clears later registrations and clears again on session shutdown.

Building this bridge requires Visual Studio C++ x64 tools and a Windows 10/11 SDK.
The build downloads checksum-verified Node headers into `.cache`; packaged users
need no compiler. The bridge links its C runtime statically.
