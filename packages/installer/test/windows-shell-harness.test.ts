import assert from "node:assert/strict";
import test from "node:test";
import {
  WINDOWS_SHELL_HARNESS_KEY,
  WINDOWS_SHELL_ENV_KEY,
  describeWindowsShellHarnessSource,
  patchWindowsShellHarnessSource,
} from "../src/windows-shell-harness";

function shellEnvironmentHydration(resultVar = "s"): string {
  return `function hydrate(${resultVar}){if(${resultVar}.status===\`loaded\`)return Object.assign(process.env,${resultVar}.userEnv),${resultVar};return ${resultVar}}`;
}

function legacyShellEnvironmentHydration(resultVar = "s"): string {
  return [
    `function hydrate(${resultVar}){if(${resultVar}.status===\`loaded\`)return Object.assign(process.env,`,
    `((__codexppNativeEnv,__codexppShellEnv)=>{`,
    `let __codexppShellPathKey=Object.keys(__codexppShellEnv).find(e=>e.toLowerCase()===\`path\`),`,
    `__codexppShellPath=__codexppShellPathKey==null?void 0:__codexppShellEnv[__codexppShellPathKey];`,
    `if(process.platform!==\`win32\`||typeof __codexppShellPath!==\`string\`||!__codexppShellPath.startsWith(\`/\`))return __codexppShellEnv;`,
    `let __codexppNativePathKey=Object.keys(__codexppNativeEnv).find(e=>e.toLowerCase()===\`path\`),`,
    `__codexppNativePath=__codexppNativePathKey==null?void 0:__codexppNativeEnv[__codexppNativePathKey];`,
    `if(typeof __codexppNativePath!==\`string\`||__codexppNativePath.length===0)return __codexppShellEnv;`,
    `return Object.fromEntries([`,
    `...Object.entries(__codexppShellEnv).filter(([e])=>e.toLowerCase()!==\`path\`),`,
    `[__codexppNativePathKey??\`Path\`,__codexppNativePath]`,
    `])`,
    `})(process.env,${resultVar}.userEnv)),/*__codexpp_windows_shell_path__*/${resultVar};return ${resultVar}}`,
  ].join("");
}

test("windows shell harness patch rewrites the restrictive SHELL guard from the live bundle", () => {
  const source = [
    "function DP(e){return e===`powershell.exe`?`powershell`:`posix`}",
    "function OP(e=m.default.env){let t=NP(e,`SHELL`);if(t!=null&&DP(t)===`powershell`)return t;let n=AP([`pwsh.exe`,`powershell.exe`],e);if(n!=null)return n;for(let t of kP(e))if((0,o.existsSync)(t))return t}",
    shellEnvironmentHydration(),
  ].join("");

  const patched = patchWindowsShellHarnessSource(source);

  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "shell-env-guard-and-path");
  assert.equal(patched.matchCount, 2);
  assert.equal(patched.guardStatus, "patched");
  assert.equal(patched.envStatus, "patched");
  assert.match(
    patched.source,
    new RegExp(
      String.raw`let t=NP\(e,\`SHELL\`\);if\(t!=null&&t\.length>0\)return t;/\*${WINDOWS_SHELL_HARNESS_KEY}\*/`,
    ),
  );
  assert.match(
    patched.source,
    new RegExp(String.raw`/\*${WINDOWS_SHELL_ENV_KEY}\*/`),
  );
  assert.doesNotMatch(patched.source, /DP\(t\)===`powershell`/);
});

test("windows shell harness patch rewrites the regex-based guard from current Store bundles", () => {
  const source = [
    "function GJ(e){let t=KJ(e,`SHELL`);if(t!=null&&/(?:^|[\\\\/])(?:pwsh|powershell)(?:\\.exe)?$/i.test(t))return t;let n=[[KJ(e,`SystemRoot`)??`C:\\\\Windows`,`System32`,`WindowsPowerShell`,`v1.0`]]}",
    shellEnvironmentHydration(),
  ].join("");

  const patched = patchWindowsShellHarnessSource(source);

  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "shell-env-guard-and-path");
  assert.equal(patched.matchCount, 2);
  assert.equal(patched.guardStatus, "patched");
  assert.equal(patched.envStatus, "patched");
  assert.match(
    patched.source,
    new RegExp(
      String.raw`let t=KJ\(e,\`SHELL\`\);if\(t!=null&&t\.length>0\)return t;/\*${WINDOWS_SHELL_HARNESS_KEY}\*/`,
    ),
  );
  assert.doesNotMatch(patched.source, /pwsh\|powershell.*\.test\(t\)/);
});

test("windows shell harness patch is idempotent after marker insertion", () => {
  const first = patchWindowsShellHarnessSource(
    [
      "function DP(e){return e===`powershell.exe`?`powershell`:`posix`}",
      "function OP(e=m.default.env){let t=NP(e,`SHELL`);if(t!=null&&DP(t)===`powershell`)return t;let n=AP([`pwsh.exe`,`powershell.exe`],e);if(n!=null)return n}",
      shellEnvironmentHydration(),
    ].join(""),
  );
  assert.ok(first);

  const patched = patchWindowsShellHarnessSource(first.source);

  assert.ok(patched);
  assert.equal(patched.changed, false);
  assert.equal(patched.strategy, "already-patched");
  assert.equal(patched.guardStatus, "already-patched");
  assert.equal(patched.envStatus, "already-patched");
});

test("windows shell harness patch upgrades an existing guard-only installation", () => {
  const source = [
    "function DP(e){return e===`powershell.exe`?`powershell`:`posix`}",
    "function OP(e=m.default.env){let t=NP(e,`SHELL`);if(t!=null&&t.length>0)return t;/*__codexpp_windows_shell_harness__*/let n=AP([`pwsh.exe`,`powershell.exe`],e);if(n!=null)return n}",
    shellEnvironmentHydration(),
  ].join("");

  const patched = patchWindowsShellHarnessSource(source);

  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "shell-env-path");
  assert.equal(patched.guardStatus, "already-patched");
  assert.equal(patched.envStatus, "patched");
  assert.match(
    patched.source,
    new RegExp(String.raw`/\*${WINDOWS_SHELL_ENV_KEY}\*/`),
  );
});

test("windows shell harness patch upgrades the legacy PATH-only hydration patch", () => {
  const source = [
    "function OP(e=m.default.env){let t=NP(e,`SHELL`);if(t!=null&&t.length>0)return t;/*__codexpp_windows_shell_harness__*/let n=AP([`pwsh.exe`,`powershell.exe`],e);if(n!=null)return n}",
    legacyShellEnvironmentHydration(),
  ].join("");

  const patched = patchWindowsShellHarnessSource(source);

  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.guardStatus, "already-patched");
  assert.equal(patched.envStatus, "patched");
  assert.match(
    patched.source,
    new RegExp(String.raw`/\*${WINDOWS_SHELL_ENV_KEY}\*/`),
  );
  assert.doesNotMatch(patched.source, /__codexpp_windows_shell_path__/);
});

test("windows shell harness patch treats an upstream permissive guard as already fixed", () => {
  const source = [
    "function OP(e=m.default.env){let t=NP(e,`SHELL`);if(t!=null&&t.length>0)return t;let n=AP([`pwsh.exe`,`powershell.exe`],e);if(n!=null)return n}",
    shellEnvironmentHydration(),
  ].join("");

  const patched = patchWindowsShellHarnessSource(source);

  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "shell-env-path");
  assert.equal(patched.guardStatus, "already-fixed");
  assert.equal(patched.envStatus, "patched");
});

test("windows shell harness preserves native Windows variables for a POSIX shell", () => {
  const source = [
    shellEnvironmentHydration(),
    "globalThis.result=hydrate({status:`loaded`,userEnv:{PATH:`/usr/bin:/c/Program Files/nodejs`,Path:`/duplicate`,TEMP:`/tmp`,TMP:`/tmp`,HOME:`/c/Users/Example User`,PWD:`/d/project`,OLDPWD:`/d`,SHLVL:`2`,_:`/usr/bin/env`,SHELL:`/usr/bin/bash`,MSYSTEM:`UCRT64`,KEEP:`yes`}});",
  ].join("");

  const patched = patchWindowsShellHarnessSource(source);
  assert.ok(patched);

  const processMock = {
    platform: "win32",
    env: {
      Path: "C:\\WINDOWS\\System32;C:\\msys64\\usr\\bin;C:\\Program Files\\nodejs",
      TEMP: "C:\\Users\\Example User\\AppData\\Local\\Temp",
      TMP: "C:\\Users\\Example User\\AppData\\Local\\Temp",
      HOME: "C:\\Users\\Example User",
      PWD: "D:\\Projekte\\Codex Desktop App Fork",
    } as Record<string, string>,
  };
  const context: Record<string, unknown> = {};
  new Function("process", "globalThis", patched.source)(processMock, context);

  assert.equal(
    processMock.env.Path,
    "C:\\WINDOWS\\System32;C:\\msys64\\usr\\bin;C:\\Program Files\\nodejs",
  );
  assert.equal(processMock.env.PATH, undefined);
  assert.equal(processMock.env.TEMP, "C:\\Users\\Example User\\AppData\\Local\\Temp");
  assert.equal(processMock.env.TMP, "C:\\Users\\Example User\\AppData\\Local\\Temp");
  assert.equal(processMock.env.HOME, "C:\\Users\\Example User");
  assert.equal(processMock.env.PWD, "D:\\Projekte\\Codex Desktop App Fork");
  assert.equal(processMock.env.OLDPWD, undefined);
  assert.equal(processMock.env.SHLVL, undefined);
  assert.equal(processMock.env._, undefined);
  assert.equal(processMock.env.SHELL, "/usr/bin/bash");
  assert.equal(processMock.env.MSYSTEM, "UCRT64");
  assert.equal(processMock.env.KEEP, "yes");
  assert.equal(
    Object.keys(processMock.env).filter((key) => key.toLowerCase() === "path")
      .length,
    1,
  );
});

test("windows shell harness leaves native shell PATH values unchanged", () => {
  const source = [
    shellEnvironmentHydration(),
    "hydrate({status:`loaded`,userEnv:{Path:`C:\\\\Tools;C:\\\\Windows`,KEEP:`yes`}});",
  ].join("");
  const patched = patchWindowsShellHarnessSource(source);
  assert.ok(patched);

  const processMock = {
    platform: "win32",
    env: { Path: "C:\\Original" } as Record<string, string>,
  };
  new Function("process", patched.source)(processMock);

  assert.equal(processMock.env.Path, "C:\\Tools;C:\\Windows");
  assert.equal(processMock.env.KEEP, "yes");
});

test("windows shell harness leaves POSIX PATH unchanged outside Windows", () => {
  const source = [
    shellEnvironmentHydration(),
    "hydrate({status:`loaded`,userEnv:{PATH:`/usr/local/bin:/usr/bin`,KEEP:`yes`}});",
  ].join("");
  const patched = patchWindowsShellHarnessSource(source);
  assert.ok(patched);

  const processMock = {
    platform: "linux",
    env: { PATH: "/native/bin" } as Record<string, string>,
  };
  new Function("process", patched.source)(processMock);

  assert.equal(processMock.env.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(processMock.env.KEEP, "yes");
});

test("windows shell harness leaves shell PATH unchanged when no native PATH exists", () => {
  const source = [
    shellEnvironmentHydration(),
    "hydrate({status:`loaded`,userEnv:{PATH:`/usr/local/bin:/usr/bin`,KEEP:`yes`}});",
  ].join("");
  const patched = patchWindowsShellHarnessSource(source);
  assert.ok(patched);

  const processMock = {
    platform: "win32",
    env: {} as Record<string, string>,
  };
  new Function("process", patched.source)(processMock);

  assert.equal(processMock.env.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(processMock.env.KEEP, "yes");
});

test("windows shell harness diagnostics report the restrictive guard", () => {
  const source =
    "function OP(e=m.default.env){let t=NP(e,`SHELL`);if(t!=null&&DP(t)===`powershell`)return t;let n=AP([`pwsh.exe`,`powershell.exe`],e)}";

  const diagnostics = describeWindowsShellHarnessSource(source);

  assert.equal(diagnostics.hasMarker, false);
  assert.equal(diagnostics.hasEnvMarker, false);
  assert.equal(diagnostics.hasLegacyPathMarker, false);
  assert.equal(diagnostics.restrictiveMatches, 1);
  assert.equal(diagnostics.permissiveMatches, 0);
  assert.equal(diagnostics.envHydrationMatches, 0);
  assert.equal(diagnostics.legacyEnvHydrationMatches, 0);
  assert.match(diagnostics.snippet ?? "", /SHELL/);
});

test("windows shell harness diagnostics report the current regex-based guard", () => {
  const source =
    "function GJ(e){let t=KJ(e,`SHELL`);if(t!=null&&/(?:^|[\\\\/])(?:pwsh|powershell)(?:\\.exe)?$/i.test(t))return t}";

  const diagnostics = describeWindowsShellHarnessSource(source);

  assert.equal(diagnostics.restrictiveMatches, 1);
  assert.equal(diagnostics.permissiveMatches, 0);
  assert.match(diagnostics.snippet ?? "", /pwsh\|powershell/);
});
