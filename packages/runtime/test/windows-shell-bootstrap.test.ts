import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  applyWindowsShellBootstrap,
  type WindowsPersistedPathSnapshot,
} from "../src/windows-shell-bootstrap";

test("applyWindowsShellBootstrap prefers the configured bash shell and normalizes Windows env", {
  skip: process.platform !== "win32",
}, () => {
  withTempDir((root) => {
    const shellPath = writeFile(root, "msys64", "usr", "bin", "bash.exe");
    const gitPath = writeFile(root, "Program Files", "Git", "cmd", "git.exe");
    const codexConfigPath = writeTextFile(
      root,
      ".codex",
      "config.toml",
      [
        "[shell_environment_policy.set]",
        'MSYSTEM = "UCRT64"',
        'CHERE_INVOKING = "1"',
        'MSYS2_PATH_TYPE = "inherit"',
        "",
      ].join("\n"),
    );
    const systemRoot = join(root, "Windows");
    const userProfile = join(root, "Users", "Example User");

    mkdirSync(userProfile, { recursive: true });
    mkdirSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
    mkdirSync(join(systemRoot, "System32", "Wbem"), { recursive: true });
    writeFile(systemRoot, "System32", "cmd.exe");

    withEnv(
      {
        SHELL: shellPath,
        MSYSTEM: "",
        CHERE_INVOKING: "",
        PATH: "C:\\Existing\\Bin",
        Path: "C:\\Existing\\Bin",
        ProgramFiles: join(root, "Program Files"),
        "ProgramFiles(x86)": "",
        USERPROFILE: userProfile,
        HOME: "C:\\msys64\\home\\doca",
        SystemDrive: root.slice(0, 2),
        SystemRoot: systemRoot,
        COMSPEC: "",
      },
      () => {
        const logs: Array<[string, ...unknown[]]> = [];

        applyWindowsShellBootstrap((level, ...args) => {
          logs.push([level, ...args]);
        }, { codexConfigPath });

        assert.equal(process.env.SHELL, shellPath);
        assert.equal(process.env.MSYSTEM, "UCRT64");
        assert.equal(process.env.CHERE_INVOKING, "1");
        assert.equal(process.env.MSYS2_PATH_TYPE, "inherit");
        assert.equal(process.env.COMSPEC, join(systemRoot, "System32", "cmd.exe"));
        assert.equal(process.env.HOME, userProfile);

        const pathEntries = (process.env.PATH ?? "").split(";");
        assert.deepEqual(pathEntries.slice(0, 7), [
          dirname(gitPath),
          join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
          join(systemRoot, "System32"),
          systemRoot,
          join(systemRoot, "System32", "Wbem"),
          dirname(shellPath),
          dirname(dirname(shellPath)),
        ]);
        assert.equal(pathEntries.at(-1), "C:\\Existing\\Bin");

        assert.equal(logs.length, 1);
        assert.equal(logs[0]?.[0], "info");
        assert.equal(logs[0]?.[1], "windows shell bootstrap applied");
        assert.equal(logMetadata(logs[0]).mergedPersistedPathEntries, 0);
      },
    );
  });
});

test("applyWindowsShellBootstrap merges persisted Windows PATH entries when the inherited PATH looks trimmed", {
  skip: process.platform !== "win32",
}, () => {
  withTempDir((root) => {
    const shellPath = writeFile(root, "msys64", "usr", "bin", "bash.exe");
    const gitPath = writeFile(root, "Program Files", "Git", "cmd", "git.exe");
    const codexConfigPath = writeTextFile(
      root,
      ".codex",
      "config.toml",
      [
        "[shell_environment_policy.set]",
        'MSYSTEM = "UCRT64"',
        'CHERE_INVOKING = "1"',
        'MSYS2_PATH_TYPE = "inherit"',
        "",
      ].join("\n"),
    );
    const systemRoot = join(root, "Windows");
    const userProfile = join(root, "Users", "Example User");
    const cmakeDir = join(root, "Program Files", "CMake", "bin");
    const cargoDir = join(userProfile, ".cargo", "bin");
    const pythonDir = join(userProfile, "AppData", "Local", "Programs", "Python", "Python313");

    mkdirSync(userProfile, { recursive: true });
    mkdirSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
    mkdirSync(join(systemRoot, "System32", "Wbem"), { recursive: true });
    mkdirSync(cmakeDir, { recursive: true });
    mkdirSync(cargoDir, { recursive: true });
    mkdirSync(pythonDir, { recursive: true });
    writeFile(systemRoot, "System32", "cmd.exe");

    withEnv(
      {
        SHELL: shellPath,
        MSYSTEM: "",
        CHERE_INVOKING: "",
        PATH: "C:\\Existing\\Bin",
        Path: "C:\\Existing\\Bin",
        ProgramFiles: join(root, "Program Files"),
        "ProgramFiles(x86)": "",
        USERPROFILE: userProfile,
        HOME: "C:\\msys64\\home\\doca",
        SystemDrive: root.slice(0, 2),
        SystemRoot: systemRoot,
        COMSPEC: "",
      },
      () => {
        const logs: Array<[string, ...unknown[]]> = [];
        const persisted: WindowsPersistedPathSnapshot = {
          machine: [
            join(systemRoot, "System32"),
            cmakeDir,
            dirname(gitPath),
          ].join(";"),
          user: [
            cargoDir,
            "%USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python313",
          ].join(";"),
        };

        applyWindowsShellBootstrap((level, ...args) => {
          logs.push([level, ...args]);
        }, {
          codexConfigPath,
          readPersistedPath: () => persisted,
        });

        assert.equal(process.env.MSYS2_PATH_TYPE, "inherit");
        const pathEntries = (process.env.PATH ?? "").split(";");
        assert.deepEqual(pathEntries.slice(-4), [
          "C:\\Existing\\Bin",
          cmakeDir,
          cargoDir,
          pythonDir,
        ]);
        assert.equal(logMetadata(logs[0]).mergedPersistedPathEntries, 4);
      },
    );
  });
});

test("applyWindowsShellBootstrap normalizes an inherited MSYS PATH before merging persisted Windows PATH entries", {
  skip: process.platform !== "win32",
}, () => {
  withTempDir((root) => {
    const shellPath = writeFile(root, "msys64", "usr", "bin", "bash.exe");
    const gitPath = writeFile(root, "Program Files", "Git", "cmd", "git.exe");
    const codexConfigPath = writeTextFile(
      root,
      ".codex",
      "config.toml",
      [
        "[shell_environment_policy.set]",
        'MSYSTEM = "UCRT64"',
        'CHERE_INVOKING = "1"',
        'MSYS2_PATH_TYPE = "inherit"',
        "",
      ].join("\n"),
    );
    const systemRoot = join(root, "Windows");
    const userProfile = join(root, "Users", "Example User");
    const cmakeDir = join(root, "Program Files", "CMake", "bin");
    const cargoDir = join(userProfile, ".cargo", "bin");
    const pythonDir = join(userProfile, "AppData", "Local", "Programs", "Python", "Python313");

    mkdirSync(userProfile, { recursive: true });
    mkdirSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
    mkdirSync(join(systemRoot, "System32", "Wbem"), { recursive: true });
    mkdirSync(cmakeDir, { recursive: true });
    mkdirSync(cargoDir, { recursive: true });
    mkdirSync(pythonDir, { recursive: true });
    writeFile(systemRoot, "System32", "cmd.exe");

    withEnv(
      {
        SHELL: shellPath,
        MSYSTEM: "",
        CHERE_INVOKING: "",
        PATH: [
          "/ucrt64/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/c/Windows/System32",
          "/c/Windows",
          "/c/Windows/System32/Wbem",
          "/c/Windows/System32/WindowsPowerShell/v1.0",
          "/usr/bin/site_perl",
          "/usr/bin/vendor_perl",
          "/usr/bin/core_perl",
        ].join(":"),
        Path: [
          "/ucrt64/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/c/Windows/System32",
          "/c/Windows",
          "/c/Windows/System32/Wbem",
          "/c/Windows/System32/WindowsPowerShell/v1.0",
          "/usr/bin/site_perl",
          "/usr/bin/vendor_perl",
          "/usr/bin/core_perl",
        ].join(":"),
        ProgramFiles: join(root, "Program Files"),
        "ProgramFiles(x86)": "",
        USERPROFILE: userProfile,
        HOME: "C:\\msys64\\home\\doca",
        SystemDrive: root.slice(0, 2),
        SystemRoot: systemRoot,
        COMSPEC: "",
      },
      () => {
        const logs: Array<[string, ...unknown[]]> = [];
        const persisted: WindowsPersistedPathSnapshot = {
          machine: [
            join(systemRoot, "System32"),
            cmakeDir,
            dirname(gitPath),
          ].join(";"),
          user: [
            cargoDir,
            "%USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python313",
          ].join(";"),
        };

        applyWindowsShellBootstrap((level, ...args) => {
          logs.push([level, ...args]);
        }, {
          codexConfigPath,
          readPersistedPath: () => persisted,
        });

        assert.equal(process.env.MSYS2_PATH_TYPE, "inherit");
        const pathEntries = (process.env.PATH ?? "").split(";");
        assert.ok(!pathEntries.some((entry) => entry.includes("/ucrt64/bin")));
        assert.ok(pathEntries.includes(join(root, "msys64", "ucrt64", "bin")));
        assert.ok(pathEntries.includes(join(root, "msys64", "usr", "local", "bin")));
        assert.ok(pathEntries.includes(join(root, "msys64", "usr", "bin", "site_perl")));
        assert.ok(pathEntries.includes(cmakeDir));
        assert.ok(pathEntries.includes(cargoDir));
        assert.ok(pathEntries.includes(pythonDir));
        assert.equal(logMetadata(logs[0]).mergedPersistedPathEntries, 4);
      },
    );
  });
});

test("applyWindowsShellBootstrap does not merge persisted PATH when most persisted entries are already present", {
  skip: process.platform !== "win32",
}, () => {
  withTempDir((root) => {
    const shellPath = writeFile(root, "msys64", "usr", "bin", "bash.exe");
    const gitPath = writeFile(root, "Program Files", "Git", "cmd", "git.exe");
    const codexConfigPath = writeTextFile(
      root,
      ".codex",
      "config.toml",
      [
        "[shell_environment_policy.set]",
        'MSYSTEM = "UCRT64"',
        'CHERE_INVOKING = "1"',
        'MSYS2_PATH_TYPE = "inherit"',
        "",
      ].join("\n"),
    );
    const systemRoot = join(root, "Windows");
    const userProfile = join(root, "Users", "Example User");
    const cmakeDir = join(root, "Program Files", "CMake", "bin");
    const cargoDir = join(userProfile, ".cargo", "bin");
    const pythonDir = join(userProfile, "AppData", "Local", "Programs", "Python", "Python313");

    mkdirSync(userProfile, { recursive: true });
    mkdirSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
    mkdirSync(join(systemRoot, "System32", "Wbem"), { recursive: true });
    mkdirSync(cmakeDir, { recursive: true });
    mkdirSync(cargoDir, { recursive: true });
    mkdirSync(pythonDir, { recursive: true });
    writeFile(systemRoot, "System32", "cmd.exe");

    withEnv(
      {
        SHELL: shellPath,
        MSYSTEM: "",
        CHERE_INVOKING: "",
        PATH: ["C:\\Existing\\Bin", cmakeDir, cargoDir].join(";"),
        Path: ["C:\\Existing\\Bin", cmakeDir, cargoDir].join(";"),
        ProgramFiles: join(root, "Program Files"),
        "ProgramFiles(x86)": "",
        USERPROFILE: userProfile,
        HOME: "C:\\msys64\\home\\doca",
        SystemDrive: root.slice(0, 2),
        SystemRoot: systemRoot,
        COMSPEC: "",
      },
      () => {
        const logs: Array<[string, ...unknown[]]> = [];
        const persisted: WindowsPersistedPathSnapshot = {
          machine: [cmakeDir, dirname(gitPath)].join(";"),
          user: [cargoDir, pythonDir].join(";"),
        };

        applyWindowsShellBootstrap((level, ...args) => {
          logs.push([level, ...args]);
        }, {
          codexConfigPath,
          readPersistedPath: () => persisted,
        });

        assert.equal(process.env.MSYS2_PATH_TYPE, "inherit");
        const pathEntries = (process.env.PATH ?? "").split(";");
        assert.ok(pathEntries.includes(dirname(gitPath)));
        assert.ok(!pathEntries.includes(pythonDir));
        assert.equal(logMetadata(logs[0]).mergedPersistedPathEntries, 0);
      },
    );
  });
});

test("applyWindowsShellBootstrap does not inject MSYS defaults when shell_environment_policy is absent", {
  skip: process.platform !== "win32",
}, () => {
  withTempDir((root) => {
    const shellPath = writeFile(root, "msys64", "usr", "bin", "bash.exe");
    const systemRoot = join(root, "Windows");
    const userProfile = join(root, "Users", "Example User");

    mkdirSync(userProfile, { recursive: true });
    mkdirSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
    mkdirSync(join(systemRoot, "System32", "Wbem"), { recursive: true });
    writeFile(systemRoot, "System32", "cmd.exe");

    withEnv(
      {
        SHELL: shellPath,
        MSYSTEM: "",
        CHERE_INVOKING: "",
        MSYS2_PATH_TYPE: "",
        PATH: "C:\\Existing\\Bin",
        Path: "C:\\Existing\\Bin",
        ProgramFiles: join(root, "Program Files"),
        "ProgramFiles(x86)": "",
        USERPROFILE: userProfile,
        HOME: "C:\\msys64\\home\\doca",
        SystemDrive: root.slice(0, 2),
        SystemRoot: systemRoot,
        COMSPEC: "",
      },
      () => {
        applyWindowsShellBootstrap(() => {});
        assert.equal(process.env.MSYSTEM, "");
        assert.equal(process.env.CHERE_INVOKING, "");
        assert.equal(process.env.MSYS2_PATH_TYPE, "");
      },
    );
  });
});

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "codexpp-shell-bootstrap-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withEnv(overrides: Record<string, string>, fn: () => void): void {
  const snapshot = { ...process.env };
  try {
    for (const [key, value] of Object.entries(overrides)) {
      process.env[key] = value;
    }
    fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
  }
}

function logMetadata(entry: [string, ...unknown[]] | undefined): { mergedPersistedPathEntries?: number } {
  const metadata = entry?.[2];
  return typeof metadata === "object" && metadata !== null
    ? metadata as { mergedPersistedPathEntries?: number }
    : {};
}

function writeFile(root: string, ...segments: string[]): string {
  const filePath = join(root, ...segments);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, "");
  return filePath;
}

function writeTextFile(root: string, ...segmentsAndContent: string[]): string {
  const content = segmentsAndContent.pop() ?? "";
  const filePath = join(root, ...segmentsAndContent);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}
