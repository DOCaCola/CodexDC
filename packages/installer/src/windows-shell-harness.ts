export const WINDOWS_SHELL_HARNESS_KEY = "__codexpp_windows_shell_harness__";
export const WINDOWS_SHELL_ENV_KEY = "__codexpp_windows_shell_native_env_v2__";

const LEGACY_WINDOWS_SHELL_PATH_KEY = "__codexpp_windows_shell_path__";
const WINDOWS_NATIVE_ENV_KEYS = [
  "path",
  "temp",
  "tmp",
  "tmpdir",
  "home",
  "pwd",
  "oldpwd",
  "shlvl",
  "_",
];

export type WindowsShellHarnessComponentStatus =
  "patched" | "already-patched" | "already-fixed" | "missing";

export interface WindowsShellHarnessPatch {
  source: string;
  changed: boolean;
  strategy:
    | "already-patched"
    | "already-fixed"
    | "shell-env-guard"
    | "shell-env-path"
    | "shell-env-guard-and-path";
  matchCount: number;
  guardStatus: WindowsShellHarnessComponentStatus;
  envStatus: WindowsShellHarnessComponentStatus;
}

export interface WindowsShellHarnessSourceDiagnostics {
  hasMarker: boolean;
  hasEnvMarker: boolean;
  hasLegacyPathMarker: boolean;
  restrictiveMatches: number;
  permissiveMatches: number;
  envHydrationMatches: number;
  legacyEnvHydrationMatches: number;
  shellMentions: number;
  powershellMentions: number;
  snippet: string | null;
}

const SHELL_GUARD_RE =
  /(let\s+([$\w]+)\s*=\s*[^;]*([`'"])SHELL\3[^;]*;\s*)if\(\2!=null&&([\s\S]*?)\)return \2;?/g;
const PERMISSIVE_SHELL_GUARD_RE =
  /let\s+([$\w]+)\s*=\s*[^;]*([`'"])SHELL\2[^;]*;\s*if\(\1!=null&&\1\.length>0\)return \1;/g;
const SHELL_ENV_HYDRATION_RE =
  /if\(([$\w]+)\.status===([`'"])loaded\2\)return Object\.assign\(process\.env,\1\.userEnv\),/g;
const LEGACY_SHELL_ENV_HYDRATION_RE =
  /if\(([$\w]+)\.status===([`'"])loaded\2\)return Object\.assign\(process\.env,\(\(__codexppNativeEnv,__codexppShellEnv\)=>\{[\s\S]*?\}\)\(process\.env,\1\.userEnv\)\),\/\*__codexpp_windows_shell_path__\*\//g;

export function patchWindowsShellHarnessSource(
  source: string,
  marker = WINDOWS_SHELL_HARNESS_KEY,
  envMarker = WINDOWS_SHELL_ENV_KEY,
): WindowsShellHarnessPatch | null {
  const hasGuardMarker = source.includes(markerComment(marker));
  const hasEnvMarker = source.includes(markerComment(envMarker));
  const restrictiveMatches = countRestrictiveShellGuards(source);
  const permissiveMatches = countMatches(source, PERMISSIVE_SHELL_GUARD_RE);

  let patched = source;
  let legacyUpgradeCount = 0;
  if (!hasEnvMarker) {
    patched = patched.replace(
      LEGACY_SHELL_ENV_HYDRATION_RE,
      (_match, resultVar: string, resultQuote: string) => {
        legacyUpgradeCount += 1;
        return `if(${resultVar}.status===${resultQuote}loaded${resultQuote})return Object.assign(process.env,${resultVar}.userEnv),`;
      },
    );
  }
  const envHydrationMatches = countMatches(patched, SHELL_ENV_HYDRATION_RE);

  let guardStatus: WindowsShellHarnessComponentStatus =
    restrictiveMatches > 0
      ? "patched"
      : hasGuardMarker
        ? "already-patched"
        : permissiveMatches > 0
          ? "already-fixed"
          : "missing";
  let envStatus: WindowsShellHarnessComponentStatus =
    envHydrationMatches > 0
      ? "patched"
      : hasEnvMarker
        ? "already-patched"
        : "missing";

  if (guardStatus === "missing" && envStatus === "missing") return null;

  let guardPatchCount = 0;
  let envPatchCount = 0;

  if (guardStatus === "patched") {
    patched = patched.replace(
      SHELL_GUARD_RE,
      (
        match,
        prefix: string,
        shellVar: string,
        _quote: string,
        condition: string,
      ) => {
        if (!isRestrictiveShellCondition(condition, shellVar)) return match;
        guardPatchCount += 1;
        return `${prefix}if(${shellVar}!=null&&${shellVar}.length>0)return ${shellVar};${markerComment(marker)}`;
      },
    );
  }

  if (envStatus === "patched") {
    patched = patched.replace(
      SHELL_ENV_HYDRATION_RE,
      (_match, resultVar: string, resultQuote: string) => {
        envPatchCount += 1;
        const nativeOnlyKeys = WINDOWS_NATIVE_ENV_KEYS
          .map((key) => `${resultQuote}${key}${resultQuote}`)
          .join(",");
        return [
          `if(${resultVar}.status===${resultQuote}loaded${resultQuote})return Object.assign(process.env,`,
          `((__codexppNativeEnv,__codexppShellEnv)=>{`,
          `let __codexppShellPathKey=Object.keys(__codexppShellEnv).find(e=>e.toLowerCase()===${resultQuote}path${resultQuote}),`,
          `__codexppShellPath=__codexppShellPathKey==null?void 0:__codexppShellEnv[__codexppShellPathKey];`,
          `if(process.platform!==${resultQuote}win32${resultQuote}||typeof __codexppShellPath!==${resultQuote}string${resultQuote}||!__codexppShellPath.startsWith(${resultQuote}/${resultQuote}))return __codexppShellEnv;`,
          `let __codexppNativePathKey=Object.keys(__codexppNativeEnv).find(e=>e.toLowerCase()===${resultQuote}path${resultQuote}),`,
          `__codexppNativePath=__codexppNativePathKey==null?void 0:__codexppNativeEnv[__codexppNativePathKey];`,
          `if(typeof __codexppNativePath!==${resultQuote}string${resultQuote}||__codexppNativePath.length===0)return __codexppShellEnv;`,
          `let __codexppNativeOnlyKeys=new Set([${nativeOnlyKeys}]);`,
          `return Object.fromEntries(Object.entries(__codexppShellEnv).filter(([e])=>!__codexppNativeOnlyKeys.has(e.toLowerCase())))`,
          `})(process.env,${resultVar}.userEnv)),${markerComment(envMarker)}`,
        ].join("");
      },
    );
  }

  if (guardStatus === "patched" && guardPatchCount === 0)
    guardStatus = "missing";
  if (envStatus === "patched" && envPatchCount === 0) envStatus = "missing";

  const changed = guardPatchCount > 0 || envPatchCount > 0 || legacyUpgradeCount > 0;
  const strategy = patchStrategy(
    guardPatchCount,
    envPatchCount,
    guardStatus,
    envStatus,
  );

  return {
    source: patched,
    changed,
    strategy,
    matchCount:
      guardPatchCount + envPatchCount + legacyUpgradeCount ||
      restrictiveMatches + permissiveMatches + envHydrationMatches,
    guardStatus,
    envStatus,
  };
}

export function describeWindowsShellHarnessSource(
  source: string,
  marker = WINDOWS_SHELL_HARNESS_KEY,
  envMarker = WINDOWS_SHELL_ENV_KEY,
): WindowsShellHarnessSourceDiagnostics {
  return {
    hasMarker: source.includes(markerComment(marker)),
    hasEnvMarker: source.includes(markerComment(envMarker)),
    hasLegacyPathMarker: source.includes(markerComment(LEGACY_WINDOWS_SHELL_PATH_KEY)),
    restrictiveMatches: countRestrictiveShellGuards(source),
    permissiveMatches: countMatches(source, PERMISSIVE_SHELL_GUARD_RE),
    envHydrationMatches: countMatches(source, SHELL_ENV_HYDRATION_RE),
    legacyEnvHydrationMatches: countMatches(source, LEGACY_SHELL_ENV_HYDRATION_RE),
    shellMentions: countLiteral(source, "SHELL"),
    powershellMentions: countLiteral(source, "powershell"),
    snippet: diagnosticSnippet(source),
  };
}

function patchStrategy(
  guardPatchCount: number,
  envPatchCount: number,
  guardStatus: WindowsShellHarnessComponentStatus,
  envStatus: WindowsShellHarnessComponentStatus,
): WindowsShellHarnessPatch["strategy"] {
  if (guardPatchCount > 0 && envPatchCount > 0)
    return "shell-env-guard-and-path";
  if (envPatchCount > 0) return "shell-env-path";
  if (guardPatchCount > 0) return "shell-env-guard";
  if (guardStatus === "already-fixed" && envStatus === "missing")
    return "already-fixed";
  return "already-patched";
}

function markerComment(marker: string): string {
  return `/*${marker}*/`;
}

function countMatches(source: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const copy = new RegExp(pattern.source, flags);
  let count = 0;
  while (copy.exec(source) !== null) count += 1;
  return count;
}

function countLiteral(source: string, literal: string): number {
  if (!literal) return 0;
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(literal, index)) >= 0) {
    count += 1;
    index += literal.length;
  }
  return count;
}

function diagnosticSnippet(source: string): string | null {
  const match =
    firstRestrictiveShellGuard(source) ??
    firstMatch(source, PERMISSIVE_SHELL_GUARD_RE) ??
    firstMatch(source, SHELL_ENV_HYDRATION_RE) ??
    firstMatch(source, LEGACY_SHELL_ENV_HYDRATION_RE) ??
    firstMatch(source, /SHELL.{0,160}powershell/s);
  if (!match || typeof match.index !== "number") return null;

  const start = Math.max(0, match.index - 80);
  const end = Math.min(
    source.length,
    match.index + Math.max(match[0].length, 160),
  );
  return source.slice(start, end).replace(/\s+/g, " ").trim();
}

function isRestrictiveShellCondition(
  condition: string,
  shellVar: string,
): boolean {
  if (!/(?:pwsh|powershell)/i.test(condition)) return false;

  const variable = escapeRegExp(shellVar);
  return (
    new RegExp(String.raw`\.test\(\s*${variable}\s*\)`).test(condition) ||
    new RegExp(
      `(?:\\([^)]*\\b${variable}\\b[^)]*\\)|\\b${variable}\\b)\\s*===\\s*([\`'"])powershell\\1`,
      "i",
    ).test(condition)
  );
}

function countRestrictiveShellGuards(source: string): number {
  const pattern = new RegExp(SHELL_GUARD_RE.source, SHELL_GUARD_RE.flags);
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (isRestrictiveShellCondition(match[4] ?? "", match[2] ?? "")) {
      count += 1;
    }
  }
  return count;
}

function firstRestrictiveShellGuard(
  source: string,
): RegExpExecArray | null {
  const pattern = new RegExp(SHELL_GUARD_RE.source, SHELL_GUARD_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (isRestrictiveShellCondition(match[4] ?? "", match[2] ?? "")) {
      return match;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstMatch(source: string, pattern: RegExp): RegExpExecArray | null {
  const flags = pattern.flags.replace(/g/g, "");
  return new RegExp(pattern.source, flags).exec(source);
}
