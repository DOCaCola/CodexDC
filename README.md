# Codex-DC

A separate, locally patched Codex desktop with optional tweaks and a selectable
CLI backend. Independent project derived from Codex++; not an official OpenAI app.

## Status

Development preview. Windows builds and automated tests run in CI. macOS arm64
has a managed-copy implementation and native build job, but needs real-Mac
validation of login, permissions, native helpers and updates before a supported
release. Distribution packages are unsigned; publisher signing/notarization
credentials have not been configured.

The official desktop application is not distributed here. Install it normally
before using CodexDC.

## Installation

Download the matching **CodexDC** package from [Releases](https://github.com/DOCaCola/CodexDC/releases)
when a reviewed release is available. CI artifacts are development previews.
Extract the complete package into a permanent folder, then run:

- Windows x64: **Setup.cmd**
- macOS Apple Silicon: **Setup.command**

The guided setup bundles Node; no Git, npm or compiler is needed. Choose
**Install a separate patched desktop**, then **Launch CodexDC**.
Windows currently supports the official Microsoft Store installation.
macOS creates `~/Applications/CodexDC.app` with its own identity and local signer.
A fresh login or permission grant may be needed. Simultaneous use of both desktop
variants is not supported until backend data/lock compatibility is verified.

Keep the extracted maintenance package at its installation location. Setup
records that location for updates, launch and recovery.

## Optional tweaks

Open **Settings → Tweak Store** in CodexDC. The
[CodexDC-Tweaks](https://github.com/DOCaCola/CodexDC-Tweaks) collection has independent
versions and updates. Core app maintenance continues with optional tweaks disabled.

## Codex CLI selection

Use **Settings → Codex-DC → Config → Codex CLI**, or Setup → Choose Codex CLI backend:

- **DC fork (default)** downloads the complete latest stable `DOCaCola/codex` release,
  checks its SHA-256, and probes app-server initialization before making it available.
- **Desktop bundled (stock)** uses the CLI supplied with the desktop.
- **Local path** uses a validated executable directly, without copying your build.

Choose a source and **Save CLI selection**. Selecting DC fork installs it when needed.
Setup also prepares it by default. Existing saved selections take precedence; on first
setup an explicit `CODEX_CLI_PATH` override is validated and saved as **Local path**.
The normal system PATH is not used to guess a backend.

Enable **Automatically update the DC fork before launch** in the CLI settings to
check stable releases at most once per hour, on Windows x64 or macOS Apple Silicon.
It is off by default and only applies when the DC fork is selected. Downloads are
checksum-verified and the complete package must pass app-server initialization
before activation. Failed updates are reported and keep the installed backend.
Running desktops are never restarted for an update. Rollback turns auto-update
off to retain the restored version. CLI equivalent:
`codexdc backend auto-update on` (or `off`).

Use **Install / update DC fork** to refresh a downloaded release. Quit and reopen Codex-DC after
finishing active tasks. Settings shows the running path separately from the saved
selection, along with the CLI version reported by the running backend at initialization.
This version omits custom build suffixes such as `-doca`. You can explicitly switch
back or select the previous fork version.
The bundled executable and system PATH are not replaced.

The Windows fork release includes hpatch, sandbox helpers, the code-mode host and
ripgrep. Its Mac package is not yet available; Mac users must select **Desktop bundled (stock)**
or **Local path** in Setup before installing. There is no automatic fallback.
Missing releases or failed validation produce a clear error and retain your selection.
The startup probe does not certify every desktop feature against every CLI version.

## Desktop updates and recovery

The **CodexDC patcher** checks for newer stable releases when CodexDC launches,
before starting the desktop. Checks are limited to once an hour. It validates
the download, refreshes the managed copy and retains the previous package.
An already-running desktop is left alone. A download failure is recorded in
`log/launch-update.log` and the installed version can still launch; a failed
recovery stops launch and reports the problem.

Turn **Update CodexDC on launch** off in Settings to disable automatic patcher
updates. Manual updates remain available through **Setup → Update CodexDC**.
Drafts and prereleases are excluded. Development checkouts use Git.
There are no scheduled tasks, LaunchAgents or background maintenance services.

Windows refreshes its managed copy from the installed Microsoft Store app.
On macOS, CodexDC checks the publisher's update feed and shows updates through
its integrated desktop notification. The update action downloads the full app
archive while CodexDC stays open, verifies its Ed25519 signature and publisher
identity, then asks the app to quit. A detached helper refreshes the managed copy
and reopens it through Launch Services. Download failures leave the app open;
repair failures reopen the previous copy and report the error. The official app
is unchanged and need not be running.

The active downloaded release is retained under `desktop-releases` only while
needed as a repair source. When the official installation has the same build
and archive, that redundant download is removed. Unused releases are pruned
after a desktop window successfully loads; a pending verified update stays
until it is applied or superseded.

macOS keeps one last working desktop at `CodexDC.app.previous`, with matching
runtime, launcher and installer state under `desktop-rollback`. Only a build
that has successfully loaded a window can replace this recovery copy when
installing a different build. Routine repairs and unsuccessful startups leave
it intact. Temporary staging and recovery files are removed after installation.
Startup selects the newer publisher source so an older official app cannot
undo a managed update.

Use Setup for safe mode, repair, logs and uninstall. User settings are retained
unless explicitly removed. A previous binary does not undo data migrations.

## Data directories

CodexDC uses `%APPDATA%\codex-dc` on Windows and
`~/Library/Application Support/codex-dc` on macOS. Windows managed desktop copies
use `%LOCALAPPDATA%\codex-dc`. This is a fresh installation: there is no import,
migration or fallback to the former `codexdc` or Codex++ directories.

On Windows, enable **Settings → Codex-DC → Desktop Integration → Use Directory Opus**
to open folders and reveal files in Directory Opus. Directory Opus must be installed;
restart CodexDC after changing the setting. It is off by default and stored as
`codexPlusPlus.directoryOpus` in `config.json`. Internal `codexPlusPlus` and `codexpp`
identifiers are retained by the tweak API.

## Development

Node 24 is required. Run:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run package
```

For a development install, run `node bin/codexdc.js install` from this checkout.
Link each local tweak with `node bin/codexdc.js dev <tweak-directory> --no-watch`.
Select a locally built CLI with `node bin/codexdc.js backend develop <executable>`,
or use Setup → Choose Codex CLI backend → Local path.
The executable remains at its build location. Rebuild the patcher with `npm run build`,
close CodexDC, and run `node bin/codexdc.js repair --force` to refresh the managed app.
Source checkouts use Git updates; automatic release updates are disabled.

macOS native builds require Xcode command-line tools and Node headers. CI uses
the pinned Node distribution from `scripts/package.mjs --node-only`.

The desktop uses the native Owl host, not Electron. Owl still exposes the
`electron` module API and retains names such as `ElectronAsarIntegrity` in its
archive metadata. The runtime uses that host API; the Electron development
dependency supplies API types only, and `@electron/asar` handles the archive
format. No Electron framework or fuse patching is used.

Source and generated artifacts are separated. Do not commit extracted Codex
bundles, application binaries, local credentials or investigation notes.
See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).
Maintainers: see [release validation](docs/releasing.md).
