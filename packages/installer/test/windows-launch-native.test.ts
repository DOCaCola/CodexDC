import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import type { DesktopProcess } from "../src/windows-launch-guard.js";

const script = resolve("packages/installer/assets/windows-launch-guard.ps1");
const invoke = (action: string, targets?: DesktopProcess[]) => execFileSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, action,
], {
  encoding: "utf8", windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CODEXDC_LAUNCH_TARGETS: JSON.stringify(targets) },
});

test("native kill revalidates identity and stops only the confirmed disposable process tree", { skip: process.platform !== "win32" }, async () => {
  const parent = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const daemon=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--','--managed-daemon'],{stdio:'ignore',detached:true});
    console.log(JSON.stringify({child:child.pid,daemon:daemon.pid}));
    setInterval(()=>{},1000);
  `], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let childPid: number | undefined, daemonPid: number | undefined;
  try {
    const [chunk] = await once(parent.stdout!, "data");
    ({ child: childPid, daemon: daemonPid } = JSON.parse(chunk.toString()));
    const rows = JSON.parse(invoke("inspect")) as DesktopProcess[];
    const target = rows.find(row => row.pid === parent.pid)!;
    assert.ok(target);
    // A recycled or changed PID must not inherit the user's confirmation.
    assert.throws(() => invoke("kill", [{ ...target, startedAt: "2000-01-01T00:00:00Z" }]), /instance changed/);
    assert.doesNotThrow(() => process.kill(parent.pid!, 0));
    const exited = once(parent, "exit");
    invoke("kill", [target]);
    await exited;
    assert.throws(() => process.kill(childPid!, 0));
    assert.doesNotThrow(() => process.kill(daemonPid!, 0), "shared daemon branch must survive");
  } finally {
    for (const pid of [parent.pid, childPid, daemonPid]) {
      if (pid) try { process.kill(pid); } catch { /* Disposable process already exited. */ }
    }
  }
});

test("Windows warning has exactly two buttons and Cancel handles Enter and Escape", { skip: process.platform !== "win32" }, () => {
  const output = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-STA", "-Command", `
      $ErrorActionPreference='Stop'
      $source=[IO.File]::ReadAllText($env:CODEXDC_DIALOG_SCRIPT)
      $start=$source.IndexOf('    Add-Type -AssemblyName System.Windows.Forms')
      $end=$source.IndexOf('    try {', $start)
      . ([scriptblock]::Create($source.Substring($start,$end-$start)))
      try {
        $buttons=@($form.Controls | Where-Object { $_ -is [Windows.Forms.Button] })
        if ($buttons.Count -ne 2) { throw 'Expected exactly two buttons' }
        if ($kill.Text -ne 'Kill and start CodexDC') { throw 'Wrong Kill label' }
        if ($form.AcceptButton -ne $cancel -or $form.CancelButton -ne $cancel) { throw 'Cancel is not the default' }
        $timer=New-Object Windows.Forms.Timer
        $timer.Interval=100
        $timer.Add_Tick({ $timer.Stop(); $cancel.PerformClick() })
        $timer.Start()
        if ($form.ShowDialog() -ne [Windows.Forms.DialogResult]::Cancel) { throw 'Cancel failed' }
        'dialog passed'
      } finally { $timer.Dispose(); $form.Dispose() }
    `,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: { ...process.env, CODEXDC_DIALOG_SCRIPT: script } });
  assert.match(output, /dialog passed/);
});
