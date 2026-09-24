# Release validation

## Automated pipeline

Pushes to `main` build and test Windows x64 and macOS Apple Silicon packages.
The macOS job compiles the native launcher and bridge on an Apple Silicon runner.
Each package bundles a pinned, checksum-verified Node distribution. No official
Codex application files are uploaded.

Update all workspace versions and the installer/runtime version constants
together. A matching `v<version>` tag builds both targets and creates a draft
release containing platform archives and a combined SHA256SUMS. Review and
publish the draft only after acceptance. Use a new version for changed assets;
do not replace published packages in place.

The standard public-repository runners are covered by GitHub's public Actions
offering. See the [runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Artifact retention is 14 days; published release assets provide the download feed.

## Native acceptance

On each supported platform, using a separate test user:

1. Extract the full package to a permanent directory with spaces in its path.
2. Run Setup without relying on globally installed Node, npm or Git.
3. Install from a current official Codex installation. Verify the source files
   are unchanged and CodexDC launches under its separate identity.
4. Verify login, existing sessions, shell execution, file access, screenshots,
   computer use and native permissions. Quit and reopen from Start/Dock.
5. Install and disable a catalog tweak, enter safe mode, then repair.
6. Install the fork CLI. Verify initialize, normal task creation, resume, tools,
   code mode and sandbox helpers. Switch back to Desktop bundled.
7. Update official Codex, refresh the managed copy, then verify state and signing.
8. Update CodexDC from an older package. Test the older Setup entry point and
   pinned launcher after activation. Test interrupted/failed update recovery.
9. Uninstall CodexDC. Verify official Codex and retained user settings still work.

macOS login, Launch Services, stable local signing, TCC permissions, helper
identity and official updater routing require real desktop acceptance.
CI compilation and CLI smoke tests alone do not satisfy this gate.

Packages currently have no publisher signing or notarization. Local app signing
provides a persistent machine-local identity; it does not provide publisher trust.

## CLI release contract

The backend consumes the latest published, non-prerelease `DOCaCola/codex` release:

- Windows: `codex-doca-x86_64-pc-windows-msvc.zip`
- Apple Silicon: `codex-doca-aarch64-apple-darwin.tar.gz` (future)
- Both require an exact filename entry in `SHA256SUMS`.

Archives must contain `bin/codex.exe` or `bin/codex` and every runtime companion,
with no enclosing top-level folder or symlink entries. The companion distribution
contract is owned by the CLI fork. The desktop-supplied backend remains available
when no compatible fork package has been published.
