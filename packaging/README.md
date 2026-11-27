# Packaging

Templates for Flathub, the AUR and a Homebrew tap. CI doesn't publish any of them.

## After every release

Once the GitHub release is published (draft assets can't be downloaded without a login):

```
node scripts/update-packaging.mjs 4.8.0
```

It downloads the `.deb`, the universal `.dmg` and the pnpm tarball, then writes the version and sha256
into all three. The hashes in git stay zeros until the first run.

## Flatpak (Flathub)

Flathub only takes open source apps built from source, so the manifest builds the git tag offline with
pnpm and cargo instead of repackaging the `.deb`. In the Flathub repo, next to the manifest:

- `node-sources.json` and `cargo-sources.json`, regenerated from the tag for every release with
  [flatpak-builder-tools](https://github.com/flatpak/flatpak-builder-tools):
  ```
  flatpak-node-generator pnpm pnpm-lock.yaml -o node-sources.json
  python3 flatpak-cargo-generator.py src-tauri/Cargo.lock -o cargo-sources.json
  ```
- `shared-modules` as a git submodule (https://github.com/flathub/shared-modules), for the tray icon library.

Build and lint locally:

```
flatpak run org.flatpak.Builder --force-clean --user --install build io.github.tonieninja.zenith-player.json
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest io.github.tonieninja.zenith-player.json
```

The app ID is `io.github.tonieninja.zenith-player`: Flathub verifies `io.github` IDs through the GitHub
account, while `com.zenithplayer.desktop` would need the zenithplayer.com domain. The build installs the
existing desktop file and metainfo from `src-tauri/linux` and rewrites the ID in both.

Still needed in `zenith.metainfo.xml` before a submission: a `<developer id="io.github.tonieninja">` tag
with a `<name>`, and at least one `<screenshot>` with a PNG linked to a tag, not a branch. Flathub treats
appstream warnings as errors.

Doesn't work in the sandbox: the DualSense over hidraw (needs `--device=all`) and its udev rule, `zenith://`
links (the app registers them outside the sandbox) and Discord presence (needs the Discord socket).

**Before submitting:** Flathub's requirements say manifests must not contain AI-generated or AI-assisted
content, and AI-generated material in the app or its packaging has to be disclosed in the submission.
Answer that question yourself before opening the PR.

## AUR

`zenith-bin` is taken (the zenith system monitor), so the package is `zenith-player-bin`. It's x86_64
only, because CI builds no arm64 `.deb`.

```
git clone ssh://aur@aur.archlinux.org/zenith-player-bin.git
cp packaging/aur/PKGBUILD packaging/aur/.SRCINFO zenith-player-bin/
cd zenith-player-bin && makepkg -si
```

If the PKGBUILD changes beyond version and hash, regenerate `.SRCINFO` with `makepkg --printsrcinfo > .SRCINFO`.

## Homebrew

homebrew/cask doesn't accept apps that fail Gatekeeper, and Zenith isn't signed or notarized, so the cask
goes into a tap: repo `tonieninja/homebrew-tap`, file `Casks/zenith.rb`. Install with
`brew install --cask tonieninja/tap/zenith` (plain `brew install zenith` is the system monitor formula).
macOS is untested; the caveats explain how to open the app the first time.

## Known gap

The in-app updater doesn't know about these installs. Under the AUR package it offers the `.deb` and fails
without dpkg, and in the Flatpak it tries to replace a read-only binary. The app should skip it when a
package manager installed it.
