import { describe, expect, it } from 'vitest';
import { isPlaceholderCover, letterCover, localCover } from '../utils/covers';

const svgOf = (u: string) => decodeURIComponent(u.split(',')[1]);

describe('letterCover', () => {
  it('draws two uppercase letters locally and escapes markup', () => {
    const u = letterCover('chill vibes');
    expect(u.startsWith('data:image/svg+xml')).toBe(true);
    expect(svgOf(u)).toContain('>CH</text>');
    expect(svgOf(letterCover('<a'))).toContain('>&lt;A</text>');
    expect(svgOf(letterCover(''))).toContain('>?</text>');
  });

  it('turns stored ui-avatars links into local covers', () => {
    const old =
      'https://ui-avatars.com/api/?name=Ro&background=1a1a2e&color=fff&size=540&bold=true';
    const u = localCover(old);
    expect(u).not.toContain('ui-avatars');
    expect(svgOf(u)).toContain('>RO</text>');
    expect(svgOf(u)).toContain('fill="#1a1a2e"');
    expect(
      svgOf(localCover('https://ui-avatars.com/api/?name=x&background="/><script>'))
    ).not.toContain('<script>');
    expect(localCover('https://i.ytimg.com/vi/abc/hqdefault.jpg')).toBe(
      'https://i.ytimg.com/vi/abc/hqdefault.jpg'
    );
  });

  it('recognises old and new placeholders', () => {
    expect(isPlaceholderCover(letterCover('a'))).toBe(true);
    expect(isPlaceholderCover('https://ui-avatars.com/api/?name=a')).toBe(true);
    expect(isPlaceholderCover('https://i.ytimg.com/vi/abc/hqdefault.jpg')).toBe(false);
    expect(isPlaceholderCover(undefined)).toBe(false);
  });
});
