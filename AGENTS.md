# CodexDC

- Core installation and maintenance belong in `packages/installer`.
- Keep optional renderer tweaks in the separate CodexDC-Tweaks repository.
- Modify managed app copies only; never patch the official source installation.
- Preserve early Windows MSYS2/UCRT64 shell initialization.
- Keep generated assets, dependencies, extracted app code and work notes out of Git.
- Build with `npm ci --ignore-scripts` then `npm run build`; test with `npm test`.
- Validate packaged launch and update paths separately from source builds.
- macOS native identity, signing, login and computer-use behavior require a real Mac.
- Use Bash for cross-platform commands and PowerShell for Windows-specific operations.
