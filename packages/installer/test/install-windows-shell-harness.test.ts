import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { patchWindowsShellHarness } from "../src/commands/install";
import {
  WINDOWS_SHELL_HARNESS_KEY,
  WINDOWS_SHELL_ENV_KEY,
} from "../src/windows-shell-harness";

function restrictiveGuard(fnName: string): string {
  return `function ${fnName}(e=m.default.env){let t=NP(e,\`SHELL\`);if(t!=null&&DP(t)===\`powershell\`)return t;let n=AP([\`pwsh.exe\`,\`powershell.exe\`],e);if(n!=null)return n}`;
}

function regexRestrictiveGuard(fnName: string): string {
  return `function ${fnName}(e=m.default.env){let t=NP(e,\`SHELL\`);if(t!=null&&/(?:^|[\\\\/])(?:pwsh|powershell)(?:\\.exe)?$/i.test(t))return t;let n=AP([\`pwsh.exe\`,\`powershell.exe\`],e);if(n!=null)return n}`;
}

function shellEnvironmentHydration(): string {
  return "function hydrate(s){if(s.status===`loaded`)return Object.assign(process.env,s.userEnv),s;return s}";
}

test("patchWindowsShellHarness patches every matching candidate file", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-shell-harness-"));
  try {
    const buildDir = join(root, ".vite", "build");
    mkdirSync(buildDir, { recursive: true });

    const srcPath = join(buildDir, "src-test.js");
    const workerPath = join(buildDir, "worker.js");
    const mainPath = join(buildDir, "main-test.js");
    writeFileSync(srcPath, restrictiveGuard("srcGuard"));
    writeFileSync(workerPath, regexRestrictiveGuard("workerGuard"));
    writeFileSync(mainPath, shellEnvironmentHydration());

    patchWindowsShellHarness(root);

    const srcSource = readFileSync(srcPath, "utf8");
    const workerSource = readFileSync(workerPath, "utf8");
    const mainSource = readFileSync(mainPath, "utf8");

    for (const source of [srcSource, workerSource]) {
      assert.match(
        source,
        new RegExp(String.raw`/\*${WINDOWS_SHELL_HARNESS_KEY}\*/`),
      );
      assert.match(source, /if\(t!=null&&t\.length>0\)return t;/);
      assert.doesNotMatch(source, /DP\(t\)===`powershell`/);
    }
    assert.match(
      mainSource,
      new RegExp(String.raw`/\*${WINDOWS_SHELL_ENV_KEY}\*/`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchWindowsShellHarness rejects a partial guard-only patch", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-shell-harness-"));
  try {
    const buildDir = join(root, ".vite", "build");
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "src-test.js"), restrictiveGuard("srcGuard"));

    assert.throws(
      () => patchWindowsShellHarness(root),
      /Shell environment hydrations: 0/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchWindowsShellHarness patches literal-first guards in early bootstrap chunks and workers", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-shell-harness-"));
  try {
    const buildDir = join(root, ".vite", "build");
    mkdirSync(buildDir, { recursive: true });
    const guardPaths = [
      join(buildDir, "early-bootstrap-824-3c24dda6dba622ec.js"),
      join(buildDir, "worker.js"),
    ];
    for (const filePath of guardPaths) {
      writeFileSync(filePath, regexRestrictiveGuard("guard").replace("t!=null", "null!=t"));
    }
    const envPath = join(buildDir, "early-bootstrap.js");
    writeFileSync(envPath, shellEnvironmentHydration().replace("s.status===`loaded`", '"loaded"===s.status'));

    patchWindowsShellHarness(root);
    const paths = [...guardPaths, envPath];
    const patchedSources = paths.map((filePath) => readFileSync(filePath, "utf8"));
    for (const source of patchedSources.slice(0, 2)) {
      assert.ok(source.includes(`/*${WINDOWS_SHELL_HARNESS_KEY}*/`));
      assert.doesNotMatch(source, /null!=t/);
    }
    assert.ok(patchedSources[2].includes(`/*${WINDOWS_SHELL_ENV_KEY}*/`));
    patchWindowsShellHarness(root);
    assert.deepEqual(paths.map((filePath) => readFileSync(filePath, "utf8")), patchedSources);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchWindowsShellHarness rejects a partial environment-only patch", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-shell-harness-"));
  try {
    const buildDir = join(root, ".vite", "build");
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "main-test.js"), shellEnvironmentHydration());

    assert.throws(
      () => patchWindowsShellHarness(root),
      /Windows shell harness/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
