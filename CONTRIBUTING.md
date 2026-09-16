# Contributing

Node 20+, pnpm 9+, Rust stable.

```bash
pnpm install
pnpm tauri dev
```

Before a pull request:

```bash
pnpm typecheck
pnpm format:check
cd src-tauri && cargo fmt --all -- --check && cargo check --locked
```

Do not commit `src-tauri/target`, `node_modules`, `dist`, certificates, or
yt-dlp binaries.

Read [DISCLAIMER.md](./DISCLAIMER.md) and [NOTICE.md](./NOTICE.md). UI copy,
installer text, and GitHub descriptions must keep the Zenith name. Do not add
YouTube or Google logos, and do not describe the app as official.

## Scope

Playback, lyrics, sign-in, library, search, and packaging first. Plugins that
follow `ZenithPlugin` are welcome. Login is cookie capture in a WebView only;
never store Google passwords.

| Accept                         | Reject                                              |
| ------------------------------ | --------------------------------------------------- |
| Bug fixes, UI, packaging       | Saving or exporting YouTube audio/video to disk     |
| Plugins matching existing APIs | Ad-skip, Premium unlock, or DRM bypass as a feature |
| Docs that stay under Zenith    | YouTube/Google branding or "official client" copy   |

Also rejected: bulk crawl or scrape helpers, and shipping yt-dlp inside git
or the installer payload.

Playback must stay: resolve a short-lived URL, play it in the WebView, do not
build an offline file library.

## Release

Tag `vX.Y.Z` to match `package.json`, `src-tauri/tauri.conf.json`, and
`Cargo.toml`. The Release workflow attaches Windows, macOS, and Linux
artifacts to the GitHub release.

Local installers:

```bash
pnpm dist:win
pnpm dist:linux
```

`dist:linux` needs Docker Desktop (Linux engine) or WSL Ubuntu with webkit2gtk
4.1. On a fresh Windows box, enable WSL/VirtualMachinePlatform, install Docker
or Ubuntu, **reboot once**, then run the script. GitHub Actions still builds
Linux on `ubuntu-22.04` for `v*` tags.

Windows signing secrets (optional but required to quiet SmartScreen for
downloaders): SignPath (`SIGNPATH_API_TOKEN` plus Actions variables), or
`ZENITH_CODESIGN_PFX_BASE64` + password, or paid Azure Artifact Signing.
