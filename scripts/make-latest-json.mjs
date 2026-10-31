#!/usr/bin/env node
// Builds latest.json for tauri-plugin-updater from a Tauri bundle dir.
// usage: node scripts/make-latest-json.mjs <bundleDir> <version> [notes] > latest.json
// Assets are expected under https://github.com/<repo>/releases/download/v<version>/<file>.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const [bundleDir, versionArg, notes = ''] = process.argv.slice(2);
if (!bundleDir || !versionArg) {
  console.error('usage: make-latest-json.mjs <bundleDir> <version> [notes]');
  process.exit(2);
}
const version = versionArg.replace(/^v/, '');
const repo = process.env.GITHUB_REPOSITORY || 'tonieninja/zenith-player';
const base = `https://github.com/${repo}/releases/download/v${version}`;

function findSigned(sub, ext) {
  const dir = join(bundleDir, sub);
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir)
    .sort()
    .find((n) => n.endsWith(ext) && existsSync(join(dir, `${n}.sig`)));
  if (!f) return null;
  return {
    signature: readFileSync(join(dir, `${f}.sig`), 'utf8').trim(),
    url: `${base}/${encodeURIComponent(basename(f))}`,
  };
}

const platforms = {};
const appimage = findSigned('appimage', '.AppImage');
if (appimage) {
  platforms['linux-x86_64'] = appimage;
  platforms['linux-x86_64-appimage'] = appimage;
}
const deb = findSigned('deb', '.deb');
if (deb) platforms['linux-x86_64-deb'] = deb;
const rpm = findSigned('rpm', '.rpm');
if (rpm) platforms['linux-x86_64-rpm'] = rpm;
const nsis = findSigned('nsis', '_x64-setup.exe');
if (nsis) platforms['windows-x86_64'] = platforms['windows-x86_64-nsis'] = nsis;
const nsis32 = findSigned('nsis', '_x86-setup.exe');
if (nsis32) platforms['windows-i686'] = platforms['windows-i686-nsis'] = nsis32;
const msi = findSigned('msi', '.msi');
if (msi) platforms['windows-x86_64-msi'] = msi;
const mac = findSigned('macos', '.app.tar.gz');
if (mac) platforms['darwin-x86_64'] = platforms['darwin-aarch64'] = mac;

if (!Object.keys(platforms).length) {
  console.error('no signed updater artifacts found in', bundleDir);
  process.exit(1);
}
process.stdout.write(
  JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2) + '\n'
);
