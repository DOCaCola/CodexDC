# CodexDC

A separate, locally patched Codex desktop with optional tweaks and a selectable
CLI backend. Independent project derived from Codex++; not an official OpenAI app.

The top-left mode caption displays **Codex DC** or **ChatGPT DC** by default.
The dropdown menu retains the original product names.

## Status

Development preview. Windows builds and automated tests run in CI. macOS arm64
has a managed-copy implementation and native build job, but needs real-Mac
validation of login, permissions, native helpers and updates before a supported
release. Distribution packages are unsigned; publisher signing/notarization
credentials have not been configured.

The official desktop application is not distributed here. Install it normally
before using CodexDC. Keep it installed for official updates and recovery.

## Installation

Download the matching **CodexDC** package from [Releases](https://github.com/DOCaCola/CodexDC/releases)
when a reviewed release is available. CI artifacts are development previews.
Extract the complete package into a permanent folder, then run:

- Windows x64: **Setup.cmd**
- macOS Apple Silicon: **Setup.command** (experimental)

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

Use **Settings → Codex CLI**, or Setup → Choose Codex CLI backend:

- **Desktop bundled** is the default.
- **DC fork** downloads the complete latest stable `DOCaCola/codex` release,
  checks its SHA-256, and probes app-server initialization before making it available.

Use **Install / update DC fork**, then **Use DC fork**. Quit and reopen CodexDC after
finishing active tasks. Settings shows the running path separately from the saved
selection. You can explicitly switch back or select the previous fork version.
The bundled executable and system PATH are not replaced.

The Windows fork release includes hpatch, sandbox helpers, the code-mode host and
ripgrep. Its Mac package is not yet available; Mac users can use Desktop bundled.
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
On macOS, update official Codex through its menu, close both apps and launch
CodexDC. Launch checks also refresh the copy when the official app has changed.

Use Setup for safe mode, repair, logs and uninstall. User settings are retained
unless explicitly removed. A previous binary does not undo data migrations.

## Data directories

CodexDC uses `%APPDATA%\codex-dc` on Windows and
`~/Library/Application Support/codex-dc` on macOS. Windows managed desktop copies
use `%LOCALAPPDATA%\codex-dc`. This is a fresh installation: there is no import,
migration or fallback to the former `codexdc` or Codex++ directories.

Directory Opus file reveal is optional: set `codexPlusPlus.directoryOpus` to
`true` in `config.json` and restart. Internal `codexPlusPlus` and `codexpp`
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
or use Setup → Choose Codex CLI backend → Use a local development CLI.
The executable remains at its build location. Rebuild the patcher with `npm run build`,
close CodexDC, and run `node bin/codexdc.js repair --force` to refresh the managed app.
Source checkouts use Git updates; automatic release updates are disabled.

macOS native builds require Xcode command-line tools and Node headers. CI uses
the pinned Node distribution from `scripts/package.mjs --node-only`.

Source and generated artifacts are separated. Do not commit extracted Codex
bundles, application binaries, local credentials or investigation notes.
See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).
Maintainers: see [release validation](docs/releasing.md).
