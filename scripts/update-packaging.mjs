#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RELEASES = 'https://github.com/tonieninja/zenith-player/releases/download';
const FILES = {
  pkgbuild: 'packaging/aur/PKGBUILD',
  srcinfo: 'packaging/aur/.SRCINFO',
  cask: 'packaging/homebrew/zenith.rb',
  flatpak: 'packaging/flatpak/io.github.tonieninja.zenith-player.json',
};

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export const assetUrls = (version) => ({
  deb: `${RELEASES}/v${version}/Zenith_${version}_amd64.deb`,
  dmg: `${RELEASES}/v${version}/Zenith_${version}_universal.dmg`,
});

export const pnpmUrl = (version) => `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`;

// rzuca przy braku wzorca, bo cicho pominięta suma lub wersja dałaby paczkę ze starym plikiem
export function fillPackaging(files, { version, deb, dmg, pnpm }) {
  const debUrl = assetUrls(version).deb;
  const rules = {
    pkgbuild: [
      [/^pkgver=.*$/m, () => `pkgver=${version}`],
      [/^pkgrel=.*$/m, () => 'pkgrel=1'],
      [/^sha256sums_x86_64=.*$/m, () => `sha256sums_x86_64=('${deb}')`],
    ],
    srcinfo: [
      [/^\tpkgver = .*$/m, () => `\tpkgver = ${version}`],
      [/^\tpkgrel = .*$/m, () => '\tpkgrel = 1'],
      [
        /^\tsource_x86_64 = .*$/m,
        () => `\tsource_x86_64 = zenith-player-bin-${version}.deb::${debUrl}`,
      ],
      [/^\tsha256sums_x86_64 = .*$/m, () => `\tsha256sums_x86_64 = ${deb}`],
    ],
    cask: [
      [/^ {2}version ".*"$/m, () => `  version "${version}"`],
      [/^ {2}sha256 ".*"$/m, () => `  sha256 "${dmg}"`],
    ],
    flatpak: [
      [/"tag": "v[^"]*"/, () => `"tag": "v${version}"`],
      [
        /"url": "[^"]*\/pnpm-[^"]*\.tgz",(\s*)"sha256": "[0-9a-f]*"/,
        (_, gap) => `"url": "${pnpmUrl(pnpm.version)}",${gap}"sha256": "${pnpm.sha256}"`,
      ],
    ],
  };
  const out = {};
  for (const [name, list] of Object.entries(rules)) {
    out[name] = list.reduce((text, [re, to]) => {
      if (!re.test(text)) throw new Error(`${FILES[name]}: no line matches ${re}`);
      return text.replace(re, to);
    }, files[name]);
  }
  return out;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const version = (process.argv[2] || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(
      'usage: update-packaging.mjs <version>   (after the GitHub release is published)'
    );
    process.exit(2);
  }
  const root = new URL('../', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const pnpmVersion = pkg.packageManager.replace(/^pnpm@/, '').split('+')[0];
  const urls = assetUrls(version);
  const [deb, dmg, pnpmHash] = await Promise.all(
    [urls.deb, urls.dmg, pnpmUrl(pnpmVersion)].map(async (u) => sha256(await download(u)))
  );
  const read = (p) => readFileSync(new URL(p, root), 'utf8');
  const files = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)]));
  const filled = fillPackaging(files, {
    version,
    deb,
    dmg,
    pnpm: { version: pnpmVersion, sha256: pnpmHash },
  });
  for (const [k, p] of Object.entries(FILES)) writeFileSync(new URL(p, root), filled[k]);
  process.stdout.write(`deb ${deb}\ndmg ${dmg}\npnpm ${pnpmVersion} ${pnpmHash}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
