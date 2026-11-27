import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillPackaging, sha256 } from './update-packaging.mjs';

const read = (p) => readFileSync(resolve(import.meta.dirname, '../packaging', p), 'utf8');
const files = {
  pkgbuild: read('aur/PKGBUILD'),
  srcinfo: read('aur/.SRCINFO'),
  cask: read('homebrew/zenith.rb'),
  flatpak: read('flatpak/io.github.tonieninja.zenith-player.json'),
};
const DEB = 'a'.repeat(64);
const DMG = 'b'.repeat(64);
const PNPM = 'c'.repeat(64);
const fill = (f = files) =>
  fillPackaging(f, {
    version: '9.8.7',
    deb: DEB,
    dmg: DMG,
    pnpm: { version: '11.0.1', sha256: PNPM },
  });

describe('update-packaging', () => {
  it('hashes with sha256', () => {
    expect(sha256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('fills the AUR package', () => {
    const { pkgbuild, srcinfo } = fill();
    expect(pkgbuild).toMatch(/^pkgver=9\.8\.7$/m);
    expect(pkgbuild).toMatch(/^pkgrel=1$/m);
    expect(pkgbuild).toContain(`sha256sums_x86_64=('${DEB}')`);
    expect(srcinfo).toContain('\tpkgver = 9.8.7\n');
    expect(srcinfo).toContain(
      '\tsource_x86_64 = zenith-player-bin-9.8.7.deb::https://github.com/tonieninja/zenith-player/releases/download/v9.8.7/Zenith_9.8.7_amd64.deb\n'
    );
    expect(srcinfo).toContain(`\tsha256sums_x86_64 = ${DEB}\n`);
  });

  it('fills the cask with the dmg hash', () => {
    const { cask } = fill();
    expect(cask).toContain('  version "9.8.7"\n');
    expect(cask).toContain(`  sha256 "${DMG}"\n`);
  });

  it('fills the flatpak tag and pnpm tarball and keeps valid JSON', () => {
    const manifest = JSON.parse(fill().flatpak);
    const sources = manifest.modules[1].sources;
    expect(sources[0].tag).toBe('v9.8.7');
    expect(sources[1]).toMatchObject({
      url: 'https://registry.npmjs.org/pnpm/-/pnpm-11.0.1.tgz',
      sha256: PNPM,
    });
  });

  it('is idempotent and leaves other lines alone', () => {
    const once = fill();
    expect(fill(once)).toEqual(once);
    expect(once.pkgbuild.split('\n').length).toBe(files.pkgbuild.split('\n').length);
  });

  it('fails when a template line is missing', () => {
    expect(() => fill({ ...files, cask: files.cask.replace(/^ {2}sha256 .*$/m, '') })).toThrow(
      /zenith\.rb/
    );
  });
});
