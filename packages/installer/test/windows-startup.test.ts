import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CodexInstall } from "../src/platform.js";
import { officialWindowsPackageFamily, officialWindowsStartupCheck, officialWindowsStartupTasks } from "../src/windows-startup.js";

const codex = {
  platform: "win32",
  appRoot: join(tmpdir(), "codex-dc", "store-apps", "OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0", "app"),
} as CodexInstall;

test("startup uses the official package family, and ignores non-Store and non-Windows installs", () => {
  assert.equal(officialWindowsPackageFamily(codex), "OpenAI.Codex_2p2nqsd0c76g0");
  assert.equal(officialWindowsPackageFamily({ ...codex, platform: "darwin" }), null);
  assert.equal(officialWindowsPackageFamily({ ...codex, appRoot: join(tmpdir(), "unmanaged") }), null);
  assert.throws(() => officialWindowsPackageFamily({
    ...codex, appRoot: join(tmpdir(), "codex-dc", "store-apps", "invalid", "app"),
  }), /Invalid managed Windows Store package name/);
});

test("query and disable invoke the shipped helper with separate arguments", (t) => {
  const helper = readFileSync(new URL("../assets/windows-startup.ps1", import.meta.url), "utf8");
  const invocation = t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    assert.equal(file, "powershell.exe");
    const scriptIndex = args.indexOf("-File") + 1;
    assert.equal(readFileSync(args[scriptIndex], "utf8"), helper);
    assert.deepEqual(args.slice(scriptIndex + 1), [
      "-PackageFamily", "OpenAI.Codex_2p2nqsd0c76g0", "-Mode",
      invocation.mock.callCount() === 0 ? "query" : "disable",
    ]);
    assert.equal(options.windowsHide, true);
    return '[{"taskId":"App","state":1,"changed":false}]';
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(officialWindowsStartupTasks(codex), [{ taskId: "App", state: 1, changed: false }]);
    officialWindowsStartupTasks(codex, true);
    assert.equal(invocation.mock.callCount(), 2);
    assert.deepEqual(officialWindowsStartupTasks({ ...codex, platform: "darwin" }, true), []);
    assert.equal(invocation.mock.callCount(), 2);
  } finally {
    invocation.mock.restore();
    syncBuiltinESMExports();
  }
});

test("Doctor reports enabled startup, policy control, and disabled or absent tasks", () => {
  for (const state of [0, 1, 3]) {
    assert.equal(officialWindowsStartupCheck([{ taskId: "App", state, changed: false }]).ok, true);
  }
  assert.equal(officialWindowsStartupCheck([]).ok, true);
  const enabled = officialWindowsStartupCheck([{ taskId: "App", state: 2, changed: false }]);
  assert.equal(enabled.ok, "warn");
  assert.match(enabled.detail, /first launch.*codexdc repair/);
  const policy = officialWindowsStartupCheck([{ taskId: "App", state: 4, changed: false }]);
  assert.equal(policy.ok, "warn");
  assert.match(policy.detail, /enabled by policy.*administrator/);
});

test("Windows startup helper reads and disables actual fixture registry entries", { skip: process.platform !== "win32" }, () => {
  const fixture = mkdtempSync(join(tmpdir(), "CodexDC startup test "));
  const family = `CodexDCStartupTest${randomUUID().replaceAll("-", "")}_testpublisher`;
  const helper = fileURLToPath(new URL("../assets/windows-startup.ps1", import.meta.url));
  try {
    const output = childProcess.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", String.raw`
      $ErrorActionPreference = 'Stop'
      $family = $env:CODEXDC_TEST_FAMILY
      $fixture = $env:CODEXDC_TEST_FIXTURE
      $helper = $env:CODEXDC_TEST_HELPER
      $root = Join-Path 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData' $family
      function Get-AppxPackage {
        param([string]$Name)
        [pscustomobject]@{ PackageFamilyName = $family; InstallLocation = $fixture; Version = [version]'1.0.0.0' }
      }
      function Check($condition, $message) { if (!$condition) { throw $message } }
      function Run($mode) { @((& $helper -PackageFamily $family -Mode $mode | ConvertFrom-Json)) }
      function Manifest($enabled) {
        "<Package xmlns:uap5='urn:test'><Applications><Application><Extensions><uap5:Extension Category='windows.startupTask'><uap5:StartupTask TaskId='App' Enabled='$enabled'/></uap5:Extension></Extensions></Application></Applications></Package>" |
          Set-Content -LiteralPath (Join-Path $fixture 'AppxManifest.xml')
      }
      try {
        Manifest 'true'
        $taskPath = Join-Path $root 'App'
        $query = @(Run 'query')
        Check ($query.Count -eq 1 -and $query[0].state -eq 2) 'Manifest default was not read'
        Check (!(Test-Path -LiteralPath $root)) 'Query wrote to the registry'
        $disabled = Run 'disable'
        Check ($disabled[0].changed -and $disabled[0].state -eq 1) 'Manifest default was not disabled'
        Check (!(Run 'disable')[0].changed) 'Second disable was not idempotent'
        New-ItemProperty -LiteralPath $taskPath -Name UserEnabledStartupOnce -Value 1 -PropertyType DWord -Force | Out-Null
        foreach ($state in @(0, 1, 2, 3)) {
          Set-ItemProperty -LiteralPath $taskPath -Name State -Value $state
          Check ((Run 'query')[0].state -eq $state) 'Query changed the task state'
          $result = Run 'disable'
          $expected = if ($state -eq 2) { 1 } else { $state }
          Check ($result[0].state -eq $expected) 'Incorrect disabled state'
          Check ($result[0].changed -eq ($state -eq 2)) 'Incorrect changed flag'
          Check ((Get-ItemProperty -LiteralPath $taskPath).UserEnabledStartupOnce -eq 1) 'Changed an unrelated startup property'
        }
        foreach ($state in @(4, 99)) {
          Set-ItemProperty -LiteralPath $taskPath -Name State -Value $state
          $failed = $false
          try { Run 'disable' | Out-Null } catch { $failed = $true }
          Check $failed 'Policy or unknown task state was silently accepted'
          Check ((Get-ItemProperty -LiteralPath $taskPath).State -eq $state) 'Policy or unknown state was overwritten'
        }
        Remove-Item -LiteralPath $root -Recurse -Force
        Manifest 'false'
        Check ((Run 'disable')[0].state -eq 0) 'Disabled manifest default was not preserved'
        Check (!(Test-Path -LiteralPath $root)) 'Disabled task created a registry entry'
        '<Package/>' | Set-Content -LiteralPath (Join-Path $fixture 'AppxManifest.xml')
        Check (@(Run 'query').Count -eq 0) 'No-task manifest did not return an empty array'
        'Startup fixture checks passed'
      } finally {
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
      }
    `], { encoding: "utf8", windowsHide: true, timeout: 30_000, env: {
      ...process.env, CODEXDC_TEST_FAMILY: family, CODEXDC_TEST_FIXTURE: fixture, CODEXDC_TEST_HELPER: helper,
    } });
    assert.match(output, /Startup fixture checks passed/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
