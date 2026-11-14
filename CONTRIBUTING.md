# Contributing

PRs are welcome. Run `pnpm test`, `pnpm typecheck`, `pnpm lint` and `cargo test` (in `src-tauri`)
before sending one. Keep the UI in English and Polish, both strings live in `src/i18n.ts`.

Please don't add YouTube or Google logos or call the app official.

## Releasing

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
   `src-tauri/linux/zenith.metainfo.xml` and the README table, add a CHANGELOG entry.
2. Create the draft yourself first, so the release shows up under your name and not the bot's:
   `gh release create vX.Y.Z --draft --title X.Y.Z --notes-file notes.md`
3. Tag and push. CI uploads everything into that draft.
4. Check the files and publish with `gh release edit vX.Y.Z --draft=false --latest`.
