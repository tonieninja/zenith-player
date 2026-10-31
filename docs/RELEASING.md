# Releasing

Maintainer notes for a Zenith release.

## Overview

| Artifact | Built by | Signed for the updater |
| --- | --- | --- |
| `Zenith_X.Y.Z_amd64.deb`, `Zenith_X.Y.Z_amd64.AppImage` | CI on a `v*` tag ([`build.yml`](../.github/workflows/build.yml)) | yes (`.sig`) |
| `Zenith_X.Y.Z_universal.dmg`, `Zenith.app.tar.gz` (macOS, Intel + Apple Silicon) | CI only (`macos-14` runner); not code-signed or notarized, **untested** | yes (`.app.tar.gz.sig`) |
| `Zenith_X.Y.Z_x64-setup.exe` (NSIS) | maintainer (`pnpm dist:win` on Windows), or CI (unsigned for Authenticode) | yes (`.sig`) |
| `Zenith_X.Y.Z_x64_portable.exe` | maintainer (cross-built with `cargo xwin`, below) | no (download only, not in `latest.json`) |
| `latest.json`, `SHA256SUMS` | CI (`scripts/make-latest-json.mjs`) | n/a |

CI needs the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
(minisign key; the public key is in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`).
Without them CI still builds, but without updater artifacts, and nothing is published.

## Steps

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Update `CHANGELOG.md`.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. CI builds Linux, macOS and Windows,
   merges `latest.json` and `SHA256SUMS` and creates a **draft** release; check it, then publish.
4. Build the Windows installer and portable exe (below), upload them with their `.sig` /
   checksums to the same release, and add the `windows-x86_64` entry to `latest.json`
   (`node scripts/make-latest-json.mjs <bundleDir> X.Y.Z` picks up `nsis/*-setup.exe` + `.sig`).

## Windows installer (on Windows)

```powershell
pnpm dist:win      # scripts/build-windows.ps1
```

`scripts/build-windows.ps1` builds one NSIS installer, one MSI and one portable zip per arch
(`x64`, `x86`) into `dist-artifacts/windows/`. Only the x64 NSIS installer is published.
`tauri.conf.json` runs `scripts/sign-windows.ps1` on each binary (SHA-256, RFC 3161 timestamp);
set `ZENITH_SKIP_CODESIGN=1` to build without Authenticode.

## Windows portable exe (cross-built on Linux)

The portable exe is the plain release binary with a statically linked CRT, built with
[`cargo-xwin`](https://github.com/rust-cross/cargo-xwin) for the MSVC target:

```bash
rustup target add x86_64-pc-windows-msvc
pip install cargo-xwin            # or: cargo install cargo-xwin
# the Windows resource file (icon, version info) is compiled with llvm-rc; put an LLVM or
# llvm-mingw bin directory on PATH, e.g.
export PATH="$PATH:/opt/llvm-mingw/bin"
pnpm install && pnpm build        # frontend into dist/
cd src-tauri
RUSTFLAGS="-C target-feature=+crt-static" \
  cargo xwin build --release --target x86_64-pc-windows-msvc --features tauri/custom-protocol
cp target/x86_64-pc-windows-msvc/release/zenith-player.exe Zenith_X.Y.Z_x64_portable.exe
# sign for download verification (the portable exe is not in latest.json)
pnpm tauri signer sign -f ~/.tauri/zenith.key Zenith_X.Y.Z_x64_portable.exe
sha256sum Zenith_X.Y.Z_x64_portable.exe > Zenith_X.Y.Z_x64_portable.exe.sha256
```

`--features tauri/custom-protocol` embeds the built frontend instead of pointing at the dev
server. The WebView2 Runtime is not bundled: `src-tauri/src/webview2_check.rs` installs it
at first start when it is missing or older than version 100.

## Linux (local)

```bash
pnpm tauri build --bundles deb,appimage
```

From Windows, `pnpm dist:linux` runs the same build in Docker or WSL Ubuntu
(`dist-artifacts/linux/`). The AppImage bundles GStreamer (`bundleMediaFramework`) and the
build needs `patchelf` and `file`. Inside containers without FUSE, set
`APPIMAGE_EXTRACT_AND_RUN=1` so `linuxdeploy` can run. Set `TAURI_SIGNING_PRIVATE_KEY` (and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty if the key has none) to get the `.sig` files.

## Quality-assurance builds

`VITE_ZENITH_QA=1 pnpm build` plus `--features qa` adds test hooks (`window.__zenithQA`, the
`ZENITH_R200` command file). Never publish such a build; release builds contain neither.

## Windows code signing (optional)

Windows releases are currently not Authenticode-signed, so SmartScreen warns. A self-signed
certificate does not help for downloaded files. Options:

| Audience | What to do |
| --- | --- |
| This PC only | `pnpm codesign:dev`, then `pnpm codesign:trust` (Administrator) |
| Public downloads (free for OSS) | apply to [SignPath Foundation](https://signpath.org) (not wired into CI yet; suggested names: secret `SIGNPATH_API_TOKEN`, variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` |
| Public downloads (paid) | own OV/EV PFX (`ZENITH_CODESIGN_PFX_BASE64`, `ZENITH_CODESIGN_PASSWORD`) read by `scripts/sign-windows.ps1`, or Azure Artifact Signing (not wired up yet; `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`) |
| Skip | `ZENITH_SKIP_CODESIGN=1` |

## Forks

If the repository is not `tonieninja/zenith-player`, change `bundle.homepage` and
`plugins.updater.endpoints` in `src-tauri/tauri.conf.json` and `GITHUB_REPO` in
`src/utils/appUpdate.ts`, and generate your own updater key (`pnpm tauri signer generate`).

`pnpm clean:temp` deletes `src-tauri/target`, Vite `dist` and other scratch files.
