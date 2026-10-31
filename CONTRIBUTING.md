# Contributing

Node 20+, pnpm 10+, Rust stable. Windows is the primary platform; Linux is fully supported.
Build details: [README → Build from source](./README.md#build-from-source).

```bash
pnpm install
pnpm tauri dev
```

Before a pull request:

```bash
pnpm test
pnpm typecheck
pnpm format:check
cd src-tauri && cargo fmt --all -- --check && cargo check --locked && cargo test
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
| Bug fixes, UI, packaging       | Exporting YouTube audio/video out of the app        |
| Plugins matching existing APIs | Ad-skip, Premium unlock, or DRM bypass as a feature |
| Docs that stay under Zenith    | YouTube/Google branding or "official client" copy   |

Also rejected: bulk crawl or scrape helpers, and shipping yt-dlp inside git
or the installer payload.

Playback must stay: resolve a short-lived URL, play it (WebView on Windows, native
GStreamer on Linux), do not build an offline file library.

## Translations

New UI strings need English and Polish: `src/i18n.ts` for the app, `src/utils/pluginI18n.ts`
for plugin names and descriptions.

## Release

Tag `vX.Y.Z` matching the version in `package.json`, `src-tauri/tauri.conf.json`
and `src-tauri/Cargo.toml`. CI builds Windows x64 and x86 (setup and portable), Linux
`.deb`, `.rpm` and `.AppImage` and the macOS `.dmg`, signs the updater files and attaches
everything to a draft release with `latest.json` and `SHA256SUMS`. Full steps:
[docs/RELEASING.md](docs/RELEASING.md).

## Logo and icons

Don't edit the PNGs in `src-tauri/icons` by hand. Change the source SVGs in
`assets/brand/source` and run `python scripts/brand/build-brand.py`, it rebuilds the whole kit
and every app icon so they never drift apart. More in [assets/brand/README.md](assets/brand/README.md).
