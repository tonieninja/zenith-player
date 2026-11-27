import { describe, expect, it } from 'vitest';
import type React from 'react';
import { coverAttrs, imgErr, isPlaceholderCover, letterCover, localCover } from '../utils/covers';

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

describe('coverAttrs', () => {
  const tr = {
    id: 'x',
    cover: 'c=w226-h226',
    coverSmall: 's=w120-h120',
    coverLarge: 'l=w544-h544',
  };

  it('gives cards the medium cover so they stay sharp without the 544 px file', () => {
    expect(coverAttrs(tr, 'medium').src).toBe('c=w226-h226');
    expect(coverAttrs(tr, 'small').src).toBe('s=w120-h120');
    expect(coverAttrs(tr, 'large').src).toBe('l=w544-h544');
    expect(coverAttrs({ id: 'x', coverLarge: 'l' }, 'medium').src).toBe('l');
  });

  it('swaps the letterboxed hqdefault for hq720 in large covers and falls back when it is missing', () => {
    const vid = { id: 'abcdefghijk', cover: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' };
    expect(coverAttrs(vid, 'large').src).toBe('https://i.ytimg.com/vi/abcdefghijk/hq720.jpg');
    expect(coverAttrs(vid, 'medium').src).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
    const img = document.createElement('img');
    img.src = 'https://i.ytimg.com/vi/abcdefghijk/hq720.jpg';
    imgErr({ currentTarget: img } as unknown as React.SyntheticEvent<HTMLImageElement>);
    expect(img.src).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  });

  it('never leaves src empty, so the loading shimmer always ends', () => {
    expect(coverAttrs({ id: 'abcdefghijk' }, 'thumb').src).toBe(
      'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'
    );
    expect(isPlaceholderCover(coverAttrs({ id: 'MPREb_x1y2z3' }).src)).toBe(true);
  });

  it('ends on a placeholder it recognises, so a failing fallback cannot loop', () => {
    const img = document.createElement('img');
    img.src = 'https://lh3.googleusercontent.com/x=s100';
    const err = () =>
      imgErr({ currentTarget: img } as unknown as React.SyntheticEvent<HTMLImageElement>);
    err();
    expect(isPlaceholderCover(img.src)).toBe(true);
    expect(decodeURIComponent(img.src)).not.toContain('>?<');
    const placeholder = img.src;
    err();
    expect(img.src).toBe(placeholder);
  });
});
